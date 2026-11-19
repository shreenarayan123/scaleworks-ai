import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4000";
const clipDir = path.resolve(process.env.EVAL_CLIP_DIR ?? "eval-results/clips");
const ids = JSON.parse(await readFile(path.join(clipDir, "manifest.json"), "utf8")).clips.slice(0, 10).map((clip: { id: string }) => clip.id);
const started = Date.now();
const memory: number[] = [];
const monitor = setInterval(async () => {
  const response = await fetch(`${apiUrl}/metrics`);
  if (response.ok) memory.push(((await response.json()) as { rssBytes: number }).rssBytes);
}, 500);

async function upload(id: string) {
  const body = new FormData();
  body.append("file", new Blob([await readFile(path.join(clipDir, `${id}.wav`))], { type: "audio/wav" }), `${id}.wav`);
  const response = await fetch(`${apiUrl}/jobs`, { method: "POST", body });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const { jobId } = (await response.json()) as { jobId: string };
  const stages: Record<string, number> = {};
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = (await (await fetch(`${apiUrl}/jobs/${jobId}`)).json()) as { stage: string; error: string | null };
    stages[job.stage] ??= Date.now() - started;
    if (job.stage === "done" || job.stage === "failed") return { id, jobId, stages, failed: job.stage === "failed", error: job.error };
  }
}
const results = await Promise.all(ids.map(upload));
clearInterval(monitor);
console.log(JSON.stringify({
  concurrency: ids.length,
  durationMs: Date.now() - started,
  peakServerRssBytes: Math.max(0, ...memory),
  failureRate: results.filter((result) => result.failed).length / results.length,
  results,
}, null, 2));
