import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { Prisma } from "./generated/prisma/client.js";
import { claimStaleJob, isRecoverableJob, runAnalysis, runPipeline, speakerTurns } from "./pipeline.js";
import { lintToneRules } from "./llm.js";
import { publicRepCandidates } from "./speaker-role.js";
import { audioDurationSec, isSupportedAudioFile } from "./audio.js";
import { AnalysisSettingsSchema, parseAnalysisSettings } from "./analysis-settings.js";

mkdirSync(config.uploadDir, { recursive: true });
const analysisProvenance = (settings: ReturnType<typeof parseAnalysisSettings>) => ({
  rulesHash: createHash("sha256").update(JSON.stringify({ toneRules: settings.toneRules, negativeBehaviors: settings.negativeBehaviors })).digest("hex"),
  promptVersion: "tone-findings-v3",
});

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: config.maxFileSizeBytes },
  fileFilter: (_req, file, cb) => cb(null, isSupportedAudioFile(file.originalname)),
});

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, mockExternal: config.mockExternal });
});

app.post("/rules/lint", async (req, res) => {
  // Accept incomplete drafts here so local rule checks can return inline feedback
  // instead of rejecting the request before the user can see what's wrong.
  const body = z.object({ toneRules: z.array(z.string().max(5_000)), negativeBehaviors: AnalysisSettingsSchema.shape.negativeBehaviors.optional() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Tone rules are invalid." });
    return;
  }
  res.json(await lintToneRules(body.data.toneRules, body.data.negativeBehaviors ?? []));
});

app.get("/metrics", (_req, res) => {
  const memory = process.memoryUsage();
  res.json({ rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, uptimeSec: process.uptime() });
});

// Dashboard totals are workspace-wide and independent of the current page/search/filter.
app.get("/jobs/stats", async (_req, res) => {
  const jobs = await prisma.job.findMany({
    select: { stage: true, result: { select: { verdict: true, actionItems: true } } },
  });
  const stats = jobs.reduce((totals, job) => {
    const verdict = (job.result?.verdict as { verdict?: string } | null)?.verdict;
    if (job.stage === "done") {
      if (verdict === "RED") totals.needsAttention += 1;
      if (verdict === "GREEN") totals.toneOk += 1;
      if (Array.isArray(job.result?.actionItems)) totals.actionItems += job.result.actionItems.length;
    }
    if (job.stage !== "done" && job.stage !== "failed") totals.processing += 1;
    return totals;
  }, { totalCalls: jobs.length, needsAttention: 0, toneOk: 0, actionItems: 0, processing: 0 });
  res.json(stats);
});

// Upload a supported audio recording, validate its media stream, then start the pipeline.
app.post("/jobs", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Send a supported audio file (.wav, .mp3, .m4a, .mp4, .ogg, or .opus) in the multipart field "file".' });
    return;
  }
  let analysisSettings;
  try {
    const rawSettings = typeof req.body.settings === "string" ? JSON.parse(req.body.settings) : req.body.settings;
    analysisSettings = parseAnalysisSettings(rawSettings);
  } catch {
    await unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: "The analysis settings are invalid. Refresh the settings page and try again." });
    return;
  }
  let durationSec: number;
  try {
    durationSec = await audioDurationSec(req.file.path);
  } catch {
    await unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: "That file is not a valid audio recording. Check that it is not corrupt and contains audio." });
    return;
  }
  if (durationSec > config.maxDurationSec) {
    await unlink(req.file.path).catch(() => {});
    res.status(413).json({ error: `Audio duration exceeds the ${config.maxDurationSec}-second limit.` });
    return;
  }

  const job = await prisma.job.create({
    data: { fileName: req.file.originalname, filePath: req.file.path, durationSec, analysisSettings: analysisSettings as Prisma.InputJsonValue, ...analysisProvenance(analysisSettings) },
  });
  void runPipeline(job.id); // not awaited: runs in the background
  res.status(202).json({ jobId: job.id });
});

// Return a single page of jobs, plus counts for the workspace and active filter.
app.get("/jobs", async (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(req.query.pageSize) || 10)));
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
  const filterValue = typeof req.query.filter === "string" ? req.query.filter : "all";
  const filter = ["all", "RED", "GREEN", "processing", "failed"].includes(filterValue) ? filterValue : "all";
  const sort = req.query.sort === "oldest" ? "asc" : "desc";
  const where: Prisma.JobWhereInput = {};
  if (search) where.fileName = { contains: search, mode: "insensitive" };
  if (filter === "processing") where.stage = { notIn: ["done", "failed"] };
  else if (filter === "failed") where.stage = "failed";
  else if (filter === "RED" || filter === "GREEN") {
    where.result = { is: { verdict: { path: ["verdict"], equals: filter } } };
  }

  const [jobs, total, workspaceTotal] = await Promise.all([
    prisma.job.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: sort }, { id: sort }],
      include: { result: true },
    }),
    prisma.job.count({ where }),
    prisma.job.count(),
  ]);
  res.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      fileName: j.fileName,
      stage: j.stage,
      error: j.error,
      chunkTotal: j.chunkTotal,
      chunkDone: j.chunkDone,
      durationSec: j.durationSec,
      createdAt: j.createdAt,
      verdict: (j.result?.verdict as { verdict?: string } | null)?.verdict ?? null,
      actionItemCount: Array.isArray(j.result?.actionItems) ? j.result.actionItems.length : 0,
    })),
    page,
    pageSize,
    total,
    workspaceTotal,
  });
});

// Everything about one job: progress, transcript, speaker split, emotion scores, action items, flags.
app.get("/jobs/:id", async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: {
      words: { orderBy: { index: "asc" }, select: { text: true, start: true, end: true, speaker: true } },
      segments: { orderBy: { start: "asc" }, select: { start: true, end: true, text: true, emotions: true } },
      result: { select: { overallEmotions: true, evidence: true, actionItems: true, verdict: true } },
    },
  });
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  const { filePath: _hidden, ...rest } = job;
  const speakers = [...new Set(job.words.map((w) => w.speaker))]; // in order of first appearance
  res.json({ ...rest, repCandidates: publicRepCandidates(job.repCandidates), speakers, turns: speakerTurns(job.words) });
});

// Stream the original recording for the frontend's audio player.
app.get("/jobs/:id/audio", async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  res.sendFile(path.resolve(job.filePath));
});

// Override which speaker is the rep, then re-run only the steps after transcription.
app.patch("/jobs/:id/rep-speaker", async (req, res) => {
  const body = z.object({ speaker: z.string().min(1), analysisSettings: AnalysisSettingsSchema.optional() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Send JSON like { "speaker": "speaker_1" }.' });
    return;
  }
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  if (job.stage !== "done" && job.stage !== "failed" && job.stage !== "needs_speaker_confirmation") {
    res.status(409).json({ error: "This job is still processing. Try again when it finishes." });
    return;
  }
  const exists = await prisma.word.findFirst({ where: { jobId: job.id, speaker: body.data.speaker } });
  if (!exists) {
    res.status(400).json({ error: `Speaker "${body.data.speaker}" does not appear in this transcript.` });
    return;
  }

  const analysisSettings = parseAnalysisSettings(body.data.analysisSettings ?? job.analysisSettings);
  await prisma.job.update({
    where: { id: job.id },
    data: {
      repSpeaker: body.data.speaker,
      analysisSettings: analysisSettings as Prisma.InputJsonValue,
      ...analysisProvenance(analysisSettings),
      stage: "scoring_tone",
      checkpointStage: "scoring_tone",
      error: null,
    },
  });
  void runAnalysis(job.id);
  res.status(202).json({ jobId: job.id });
});

// Retry a failed job from its last durably committed checkpoint.
app.post("/jobs/:id/retry", async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.id } });
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  if (job.stage !== "failed") {
    res.status(409).json({ error: "Only failed jobs can be retried." });
    return;
  }
  await prisma.job.update({ where: { id: job.id }, data: { stage: job.checkpointStage, error: null } });
  void runPipeline(job.id);
  res.status(202).json({ jobId: job.id, resumedFrom: job.checkpointStage });
});

// Last-resort error handler: log it, return a generic 500.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err instanceof Error ? err.message : err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

async function recoverInterruptedJobs() {
  // Runs on startup and periodically in every environment. A job in an active
  // stage with no live heartbeat was abandoned by a dead worker; reset it to
  // its last committed checkpoint and resume it. updateMany makes the claim
  // atomic so multiple backend instances cannot pick up the same job.
  const cutoff = new Date(Date.now() - config.staleHeartbeatMs);
  const jobs = await prisma.job.findMany({
    where: {
      stage: { in: ["uploaded", "transcribing", "scoring_tone", "analyzing"] },
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lte: cutoff } }],
    },
    select: { id: true, stage: true, checkpointStage: true, heartbeatAt: true },
  });
  for (const job of jobs) {
    if (!isRecoverableJob(job)) continue;
    if (!(await claimStaleJob(job))) continue;
    console.warn(`[job ${job.id}] recovering interrupted pipeline from checkpoint ${job.checkpointStage}`);
    void runPipeline(job.id);
  }
}

app.listen(config.port, () => {
  console.log(`Backend on http://localhost:${config.port}${config.mockExternal ? " (MOCK_EXTERNAL=true)" : ""}`);
  const sweep = () => void recoverInterruptedJobs().catch((error: unknown) => {
    console.error("Could not recover interrupted jobs:", error instanceof Error ? error.message : error);
  });
  sweep();
  const timer = setInterval(sweep, config.staleHeartbeatMs);
  timer.unref();
});
