/**
 * Durable background pipeline.
 *
 * checkpointStage records the last stage whose outputs were committed. A failed
 * job can therefore resume without repeating completed external work.
 */
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { prisma } from "./db.js";
import type { Prisma } from "./generated/prisma/client.js";
import { negativeEvidence, overallScores, scoreSegments, type ScoredSegment } from "./emotion.js";
import { assessSpeakers, extractActionItems, judgeTone, type Line } from "./llm.js";
import { parseAnalysisSettings } from "./analysis-settings.js";
import { createEmotionChunks } from "./audio.js";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { transcribe } from "./scribe.js";
import { buildRepSegments, mergeWords, sentences, textOf, type TimedWord } from "./segments.js";
import { needsSpeakerConfirmation, speakerEvidence } from "./speaker-role.js";

export type Stage = "uploaded" | "transcribing" | "scoring_tone" | "analyzing" | "done" | "failed" | "needs_speaker_confirmation";
type Checkpoint = Exclude<Stage, "failed" | "needs_speaker_confirmation">;
const json = (value: unknown) => value as Prisma.InputJsonValue;

// A one-hour transcript has ~10k words. Writing them all inside one Prisma
// transaction exceeds its default timeout on a pooled Postgres connection.
// The checkpoint (committed only after every batch lands) makes a partial
// write safe: a retry deletes the job's rows before writing them again.
const WRITE_BATCH_SIZE = 1_000;

async function replaceWords(jobId: string, words: TimedWord[]) {
  await prisma.word.deleteMany({ where: { jobId } });
  for (let start = 0; start < words.length; start += WRITE_BATCH_SIZE) {
    await prisma.word.createMany({
      data: words.slice(start, start + WRITE_BATCH_SIZE).map((w, index) => ({ jobId, index: start + index, ...w })),
    });
  }
}

async function replaceSegments(jobId: string, segments: ScoredSegment[]) {
  await prisma.segment.deleteMany({ where: { jobId } });
  for (let start = 0; start < segments.length; start += WRITE_BATCH_SIZE) {
    await prisma.segment.createMany({
      data: segments.slice(start, start + WRITE_BATCH_SIZE).map((s) => ({
        jobId, start: s.start, end: s.end, text: s.text, emotions: json(s.emotions),
      })),
    });
  }
}

async function setStage(jobId: string, stage: Stage) {
  await prisma.job.update({ where: { id: jobId }, data: { stage, error: null } });
}

async function commitCheckpoint(jobId: string, checkpointStage: Checkpoint) {
  await prisma.job.update({
    where: { id: jobId },
    data: { checkpointStage, stage: checkpointStage, error: null },
  });
}

async function safely(jobId: string, step: () => Promise<void>) {
  try {
    await step();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job ${jobId}] failed:`, message);
    await prisma.job
      .update({ where: { id: jobId }, data: { stage: "failed", error: message.slice(0, 1000) } })
      .catch(() => {});
  }
}

// Lease / heartbeat: a live worker refreshes heartbeatAt every
// HEARTBEAT_INTERVAL_MS. A job left in an active stage with a stale (or null)
// heartbeat is safe for another worker to reclaim on startup.
const ACTIVE_STAGES: Stage[] = ["uploaded", "transcribing", "scoring_tone", "analyzing"];
const workerId = randomUUID();

export function isRecoverableJob(job: { stage: string; heartbeatAt: Date | null }, now = Date.now()) {
  if (!ACTIVE_STAGES.includes(job.stage as Stage)) return false;
  if (!job.heartbeatAt) return true;
  return job.heartbeatAt.getTime() <= now - config.staleHeartbeatMs;
}

export async function claimStaleJob(job: { id: string; stage: string; checkpointStage: string }) {
  const cutoff = new Date(Date.now() - config.staleHeartbeatMs);
  const claimed = await prisma.job.updateMany({
    where: {
      id: job.id,
      stage: job.stage,
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lte: cutoff } }],
    },
    data: { stage: job.checkpointStage, error: null, workerId: null, heartbeatAt: null },
  });
  return claimed.count === 1;
}

async function acquireLease(jobId: string) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - config.staleHeartbeatMs);
  const claimed = await prisma.job.updateMany({
    where: {
      id: jobId,
      OR: [{ workerId: null }, { heartbeatAt: null }, { heartbeatAt: { lte: staleBefore } }],
    },
    data: { workerId, heartbeatAt: now },
  });
  return claimed.count === 1;
}

async function releaseLease(jobId: string) {
  await prisma.job
    .updateMany({ where: { id: jobId, workerId }, data: { workerId: null, heartbeatAt: null } })
    .catch(() => {});
}

async function withLease(jobId: string, task: () => Promise<void>) {
  if (!(await acquireLease(jobId))) {
    console.warn(`[job ${jobId}] skipped: another worker holds the lease`);
    return;
  }
  const timer = setInterval(() => {
    void prisma.job
      .updateMany({ where: { id: jobId, workerId }, data: { heartbeatAt: new Date() } })
      .catch(() => {});
  }, config.heartbeatIntervalMs);
  timer.unref?.();
  try {
    await safely(jobId, task);
  } finally {
    clearInterval(timer);
    await releaseLease(jobId);
  }
}

export function speakerTurns(words: TimedWord[]) {
  return mergeWords(words, Infinity).map((u) => ({ speaker: u.speaker, start: u.start, end: u.end, text: textOf(u.words) }));
}

async function transcribeStage(jobId: string) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  await setStage(jobId, "transcribing");
  const transcript = await transcribe(job.id, job.filePath, job.fileName, job.durationSec);
  if (transcript.words.length === 0) throw new Error("No speech was found in the recording.");

  const perSpeaker: Record<string, string> = {};
  for (const w of transcript.words) perSpeaker[w.speaker] = perSpeaker[w.speaker] ? `${perSpeaker[w.speaker]} ${w.text}` : w.text;
  const { excerpt, stats } = speakerEvidence(transcript.words);
  const candidates = (await assessSpeakers(excerpt, stats)).sort((a, b) => b.repLikelihood - a.repLikelihood);
  const best = candidates[0];
  if (!best) throw new Error("Could not identify speakers in the transcript.");
  const needsConfirmation = needsSpeakerConfirmation(candidates);
  await replaceWords(jobId, transcript.words);
  await prisma.job.update({
    where: { id: jobId },
    data: { transcript: transcript.text, speakerTranscripts: json(perSpeaker), repSpeaker: best.speaker, repCandidates: json(candidates) },
  });
  await commitCheckpoint(jobId, "transcribing");
  if (needsConfirmation) await prisma.job.update({ where: { id: jobId }, data: { stage: "needs_speaker_confirmation" } });
}

async function scoreToneStage(jobId: string): Promise<ScoredSegment[]> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const words = await prisma.word.findMany({ where: { jobId }, orderBy: { index: "asc" } });
  if (!job.repSpeaker) throw new Error("Cannot score tone without a representative speaker.");
  await setStage(jobId, "scoring_tone");
  const repSegments = buildRepSegments(words, job.repSpeaker, job.durationSec);
  const chunked = job.durationSec > 330 ? await createEmotionChunks(job.filePath) : null;
  const chunks = chunked?.chunks ?? [{ filePath: job.filePath, startSec: 0, endSec: job.durationSec }];
  await prisma.job.update({ where: { id: jobId }, data: { chunkTotal: chunks.length, chunkDone: 0 } });
  const scoredByChunk: ScoredSegment[][] = Array(chunks.length);
  let next = 0;
  const concurrency = Math.min(config.emotionConcurrency, chunks.length);
  console.info(`[emotion] starting ${JSON.stringify({ jobId, chunks: chunks.length, concurrency })}`);
  try {
    // The service permits several concurrent inferences (bounded by its own
    // semaphore). Requests pick chunks from a shared queue, so a slow chunk
    // does not hold up the other workers.
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= chunks.length) return;
        const chunk = chunks[index]!;
        const utterances = repSegments.filter((u) => u.end > chunk.startSec && u.start < chunk.endSec).map((u) => {
          const start = Math.max(u.start, chunk.startSec);
          const end = Math.min(u.end, chunk.endSec);
          const selectedWords = u.words.filter((word) => (word.start + word.end) / 2 >= chunk.startSec && (word.start + word.end) / 2 < chunk.endSec);
          return {
            ...u,
            start: start - chunk.startSec,
            end: end - chunk.startSec,
            words: selectedWords.map((word) => ({ ...word, start: word.start - chunk.startSec, end: word.end - chunk.startSec })),
          };
        }).filter((u) => u.end > u.start && u.words.length > 0);
        const chunkStarted = performance.now();
        console.info(`[emotion] chunk started ${JSON.stringify({ jobId, chunk: index + 1, total: chunks.length, utterances: utterances.length })}`);
        let result: ScoredSegment[];
        try {
          result = await scoreSegments(chunk.filePath, utterances);
        } catch (error) {
          console.error(`[emotion] chunk failed ${JSON.stringify({ jobId, chunk: index + 1, total: chunks.length, utterances: utterances.length, elapsedMs: Math.round(performance.now() - chunkStarted), error: error instanceof Error ? error.message : String(error) })}`);
          throw error;
        }
        scoredByChunk[index] = result.map((segment) => ({ ...segment, start: segment.start + chunk.startSec, end: segment.end + chunk.startSec }));
        await prisma.job.update({ where: { id: jobId }, data: { chunkDone: { increment: 1 } } });
        console.info(`[emotion] chunk completed ${JSON.stringify({ jobId, chunk: index + 1, total: chunks.length, elapsedMs: Math.round(performance.now() - chunkStarted), utterances: utterances.length })}`);
      }
    }));
  } finally {
    if (chunked) await rm(chunked.directory, { recursive: true, force: true });
  }
  const scored = scoredByChunk.flat();
  await replaceSegments(jobId, scored);
  await commitCheckpoint(jobId, "scoring_tone");
  return scored;
}

async function loadScoredSegments(jobId: string): Promise<ScoredSegment[]> {
  const segments = await prisma.segment.findMany({ where: { jobId }, orderBy: { start: "asc" } });
  return segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: segment.text,
    emotions: segment.emotions as Record<string, number>,
  }));
}

async function analyzeStage(jobId: string, scored: ScoredSegment[]) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const settings = parseAnalysisSettings(job.analysisSettings);
  const words = await prisma.word.findMany({ where: { jobId }, orderBy: { index: "asc" } });
  if (!job.repSpeaker) throw new Error("Cannot analyze tone without a representative speaker.");
  await setStage(jobId, "analyzing");
  const overall = overallScores(scored);
  const evidence = negativeEvidence(scored);
  const lines: Line[] = sentences(words).map((s) => ({
    role: s.speaker === job.repSpeaker ? "REP" : "CUSTOMER",
    start: s.start,
    text: textOf(s.words),
  }));
  const [actionItems, verdict] = await Promise.all([
    extractActionItems(lines, settings),
    judgeTone(lines.filter((l) => l.role === "REP"), scored, overall, evidence, settings),
  ]);
  const resultData = {
    overallEmotions: json(overall),
    evidence: json(evidence),
    actionItems: json(actionItems.actionItems),
    verdict: json(verdict),
  };
  await prisma.result.upsert({ where: { jobId }, create: { jobId, ...resultData }, update: resultData });
  await commitCheckpoint(jobId, "done");
}

async function runFromCheckpoint(jobId: string, forceAnalysis = false) {
  let job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (job.checkpointStage === "done" && !forceAnalysis) return;
  if (job.checkpointStage === "uploaded") {
    await transcribeStage(jobId);
    job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  }
  if (job.stage === "needs_speaker_confirmation" && !forceAnalysis) return;
  const scored =
    job.checkpointStage === "scoring_tone" && !forceAnalysis ? await loadScoredSegments(jobId) : await scoreToneStage(jobId);
  await analyzeStage(jobId, scored);
}

export function runPipeline(jobId: string) {
  return withLease(jobId, () => runFromCheckpoint(jobId));
}

export function runAnalysis(jobId: string) {
  return withLease(jobId, () => runFromCheckpoint(jobId, true));
}
