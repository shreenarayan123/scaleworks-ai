/**
 * Durable background pipeline.
 *
 * checkpointStage records the last stage whose outputs were committed. A failed
 * job can therefore resume without repeating completed external work.
 */
import { prisma } from "./db.js";
import type { Prisma } from "./generated/prisma/client.js";
import { negativeEvidence, overallScores, scoreSegments, type ScoredSegment } from "./emotion.js";
import { extractActionItems, judgeTone, type Line } from "./llm.js";
import { transcribe } from "./scribe.js";
import { buildRepSegments, mergeWords, sentences, textOf, type TimedWord } from "./segments.js";

export type Stage = "uploaded" | "transcribing" | "scoring_tone" | "analyzing" | "done" | "failed";
type Checkpoint = Exclude<Stage, "failed">;
const json = (value: unknown) => value as Prisma.InputJsonValue;

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

export function speakerTurns(words: TimedWord[]) {
  return mergeWords(words, Infinity).map((u) => ({ speaker: u.speaker, start: u.start, end: u.end, text: textOf(u.words) }));
}

async function transcribeStage(jobId: string) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  await setStage(jobId, "transcribing");
  const transcript = await transcribe(job.filePath, job.fileName, job.durationSec);
  if (transcript.words.length === 0) throw new Error("No speech was found in the recording.");

  const perSpeaker: Record<string, string> = {};
  for (const w of transcript.words) perSpeaker[w.speaker] = perSpeaker[w.speaker] ? `${perSpeaker[w.speaker]} ${w.text}` : w.text;
  await prisma.$transaction([
    prisma.word.deleteMany({ where: { jobId } }),
    prisma.word.createMany({ data: transcript.words.map((w, index) => ({ jobId, index, ...w })) }),
    prisma.job.update({
      where: { id: jobId },
      data: { transcript: transcript.text, speakerTranscripts: json(perSpeaker), repSpeaker: transcript.words[0]!.speaker },
    }),
  ]);
  await commitCheckpoint(jobId, "transcribing");
}

async function scoreToneStage(jobId: string): Promise<ScoredSegment[]> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const words = await prisma.word.findMany({ where: { jobId }, orderBy: { index: "asc" } });
  if (!job.repSpeaker) throw new Error("Cannot score tone without a representative speaker.");
  await setStage(jobId, "scoring_tone");
  const scored = await scoreSegments(job.filePath, buildRepSegments(words, job.repSpeaker, job.durationSec));
  await prisma.$transaction([
    prisma.segment.deleteMany({ where: { jobId } }),
    prisma.segment.createMany({
      data: scored.map((s) => ({ jobId, start: s.start, end: s.end, text: s.text, emotions: json(s.emotions) })),
    }),
  ]);
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
    extractActionItems(lines),
    judgeTone(lines.filter((l) => l.role === "REP"), scored, overall, evidence),
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
  const scored =
    job.checkpointStage === "scoring_tone" && !forceAnalysis ? await loadScoredSegments(jobId) : await scoreToneStage(jobId);
  await analyzeStage(jobId, scored);
}

export function runPipeline(jobId: string) {
  return safely(jobId, () => runFromCheckpoint(jobId));
}

export function runAnalysis(jobId: string) {
  return safely(jobId, () => runFromCheckpoint(jobId, true));
}
