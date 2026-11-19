import "dotenv/config";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4000";
const clipDir = path.resolve(process.env.EVAL_CLIP_DIR ?? "eval-results/clips");
const resultDir = path.resolve(process.env.EVAL_RESULT_DIR ?? "eval-results");
await mkdir(resultDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(clipDir, "manifest.json"), "utf8")) as {
  clips: { id: string; textRed: boolean; voiceRed: boolean; notes: string }[];
};
const truth = (clip: (typeof manifest.clips)[number]) => ({ text: clip.textRed, voice: clip.voiceRed, combined: clip.textRed || clip.voiceRed });

async function runClip(id: string) {
  const body = new FormData();
  body.append("file", new Blob([await readFile(path.join(clipDir, `${id}.wav`))], { type: "audio/wav" }), `${id}.wav`);
  const upload = await fetch(`${apiUrl}/jobs`, { method: "POST", body });
  if (!upload.ok) throw new Error(`Upload failed for ${id}: ${upload.status} ${(await upload.text()).slice(0, 300)}`);
  const { jobId } = (await upload.json()) as { jobId: string };
  const started = Date.now();
  let lastStage = "";
  const stageTimes: Record<string, number> = {};
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(`${apiUrl}/jobs/${jobId}`);
    const job = (await response.json()) as { stage: string; error: string | null; result?: { verdict?: { verdict?: string; flags?: { source: string }[] } } };
    if (job.stage !== lastStage) {
      stageTimes[job.stage] = Date.now() - started;
      lastStage = job.stage;
    }
    if (job.stage === "done" || job.stage === "failed") {
      return { jobId, id, stage: job.stage, stageTimes, durationMs: Date.now() - started, error: job.error, verdict: job.result?.verdict };
    }
  }
}

const rows = [];
for (const clip of manifest.clips) {
  for (let run = 1; run <= 5; run++) {
    const row = await runClip(clip.id);
    rows.push({ ...row, run });
    await appendFile(path.join(resultDir, "evaluation-progress.ndjson"), `${JSON.stringify({ ...row, run })}\n`);
    console.log(`${clip.id} run ${run}: ${row.stage}`);
  }
}

const confusion = () => ({ tp: 0, fp: 0, tn: 0, fn: 0 });
const matrix = { text: confusion(), voice: confusion(), combined: confusion() };
const add = (bucket: ReturnType<typeof confusion>, expected: boolean, actual: boolean) => {
  if (expected && actual) bucket.tp++;
  else if (!expected && actual) bucket.fp++;
  else if (!expected && !actual) bucket.tn++;
  else bucket.fn++;
};
for (const clip of manifest.clips) {
  const clipRows = rows.filter((row) => row.id === clip.id && row.stage === "done");
  const expected = truth(clip);
  for (const row of clipRows) {
    const flags = row.verdict?.flags ?? [];
    add(matrix.text, expected.text, flags.some((flag) => flag.source === "text"));
    add(matrix.voice, expected.voice, flags.some((flag) => flag.source === "voice"));
    add(matrix.combined, expected.combined, row.verdict?.verdict === "RED");
  }
}
const metrics = Object.fromEntries(Object.entries(matrix).map(([name, bucket]) => [
  name,
  {
    ...bucket,
    precision: bucket.tp / Math.max(1, bucket.tp + bucket.fp),
    recall: bucket.tp / Math.max(1, bucket.tp + bucket.fn),
  },
]));
const stability = manifest.clips.map((clip) => {
  const verdicts = rows.filter((row) => row.id === clip.id && row.stage === "done").map((row) => row.verdict?.verdict ?? "MISSING");
  return { id: clip.id, verdicts, changes: verdicts.slice(1).filter((verdict, index) => verdict !== verdicts[index]).length, distinct: new Set(verdicts).size };
});
await writeFile(path.join(resultDir, "evaluation.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows, metrics, stability }, null, 2));
console.log(JSON.stringify({ metrics, stability }, null, 2));
