import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TARGET_S = 300;
const WINDOW_S = 30;
const CONCURRENCY = 3;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(output.slice(-500))));
  });
}

async function duration(file: string): Promise<number> {
  const output = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const seconds = Number.parseFloat(output.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read duration for ${file}`);
  return seconds;
}

async function normalize(input: string, output: string) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", output]);
}

async function silenceMidpoints(file: string): Promise<number[]> {
  const output = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.7", "-f", "null", "-"]);
  const starts = [...output.matchAll(/silence_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...output.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  return starts.map((start, index) => (start + (ends[index] ?? start)) / 2);
}

function planCuts(total: number, midpoints: number[]): number[] {
  const cuts = [0];
  while (total - cuts.at(-1)! > TARGET_S + WINDOW_S) {
    const target = cuts.at(-1)! + TARGET_S;
    const near = midpoints.filter((midpoint) => Math.abs(midpoint - target) <= WINDOW_S);
    cuts.push(near.length ? near.reduce((a, b) => Math.abs(a - target) < Math.abs(b - target) ? a : b) : target);
  }
  cuts.push(total);
  return cuts;
}

async function split(file: string, cuts: number[], directory: string) {
  const jobs = cuts.slice(0, -1).map((start, index) => ({
    index, start, duration: cuts[index + 1]! - start,
    path: path.join(directory, `chunk_${String(index).padStart(3, "0")}.opus`),
  }));
  for (const job of jobs) {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(job.start), "-t", String(job.duration), "-i", file, "-c", "copy", job.path]);
  }
  return jobs;
}

// Replace with the real downstream worker. This offline stub makes chunk scheduling and timestamp stitching measurable.
async function transcribe(_chunk: { path: string; duration: number }) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { words: [{ text: "hello", start: 0, end: 0.4, speaker: "speaker_0" }] };
}

async function poolConsume<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>, consume: (result: R, index: number) => void) {
  let next = 0;
  let nextConsume = 0;
  const pending = new Map<number, R>();
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      pending.set(index, await task(items[index]!));
      while (pending.has(nextConsume)) {
        const result = pending.get(nextConsume)!;
        pending.delete(nextConsume);
        consume(result, nextConsume++);
      }
    }
  }));
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: npx tsx backend/scripts/poc-chunking.ts <audio-file>");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "callertone-chunk-poc-"));
  const started = Date.now();
  try {
    const normalizedFile = path.join(tempDir, "normalized.opus");
    await normalize(input, normalizedFile);
    const total = await duration(normalizedFile);
    const midpoints = await silenceMidpoints(normalizedFile);
    const cuts = planCuts(total, midpoints);
    const chunks = await split(normalizedFile, cuts, tempDir);
    let stitchedWords = 0;
    let previousStart = -Infinity;
    let monotonic = true;
    await poolConsume(chunks, CONCURRENCY, transcribe, (result, index) => {
      for (const word of result.words) {
        const start = word.start + chunks[index]!.start;
        if (start < previousStart) monotonic = false;
        previousStart = start;
        stitchedWords++;
      }
    });
    console.table({
      audioMinutes: (total / 60).toFixed(1),
      chunks: chunks.length,
      wallSeconds: ((Date.now() - started) / 1000).toFixed(2),
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
      stitchedWords,
      monotonic,
    });
    console.log("cutPointsSec:", cuts.map((cut) => Number(cut.toFixed(2))).join(", "));
    console.table(cuts.slice(1, -1).map((cut) => ({
      cutSec: Number(cut.toFixed(2)),
      nearestSilenceMidpointSec: Number((midpoints.sort((a, b) => Math.abs(a - cut) - Math.abs(b - cut))[0] ?? NaN).toFixed(2)),
    })));
    console.log("transcriptionMode: mock (no external provider call); speaker IDs are not validated by this POC");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
