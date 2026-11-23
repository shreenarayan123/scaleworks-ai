import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const supportedAudioExtensions = [".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".opus"] as const;

export function isSupportedAudioFile(fileName: string): boolean {
  return supportedAudioExtensions.includes(path.extname(fileName).toLowerCase() as (typeof supportedAudioExtensions)[number]);
}

/** Probe actual media content so corrupt files and containers without audio are rejected. */
export async function audioDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,duration",
    "-of", "json",
    filePath,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });

  const probe = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; duration?: string }[];
  };
  if (!probe.streams?.some((stream) => stream.codec_type === "audio")) {
    throw new Error("The recording contains no audio stream.");
  }

  const duration = Number(probe.format?.duration ?? probe.streams.find((stream) => stream.codec_type === "audio")?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The recording has no valid audio duration.");
  }
  return duration;
}

/** Create a compact speech-optimized copy for Scribe while retaining the original upload. */
export async function createScribeAudioCopy(filePath: string): Promise<{ directory: string; filePath: string; sizeBytes: number }> {
  const directory = await mkdtemp(path.join(tmpdir(), "callertone-scribe-audio-"));
  const outputPath = path.join(directory, "transcription.opus");
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", filePath,
      "-map", "0:a:0", "-vn", "-ar", "16000", "-ac", "1",
      "-c:a", "libopus", "-application", "voip", "-b:a", "24k", outputPath,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const { size } = await stat(outputPath);
    return { directory, filePath: outputPath, sizeBytes: size };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export interface AudioChunk { filePath: string; startSec: number; endSec: number }

/** Normalize to mono 16 kHz Opus and cut around silence points near target windows. */
export async function createEmotionChunks(filePath: string, targetSec = 300, searchWindowSec = 30): Promise<{ directory: string; chunks: AudioChunk[] }> {
  const directory = await mkdtemp(path.join(tmpdir(), "callertone-emotion-chunks-"));
  try {
    const normalized = path.join(directory, "normalized.opus");
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", filePath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", normalized], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const total = await audioDurationSec(normalized);
    const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-i", normalized, "-af", "silencedetect=noise=-35dB:d=0.7", "-f", "null", "-"], { windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
    const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
    const mids = starts.map((start, index) => (start + (ends[index] ?? start)) / 2);
    const cuts = [0];
    while (total - cuts.at(-1)! > targetSec + searchWindowSec) {
      const target = cuts.at(-1)! + targetSec;
      const nearby = mids.filter((mid) => Math.abs(mid - target) <= searchWindowSec);
      cuts.push(nearby.length ? nearby.reduce((a, b) => Math.abs(a - target) <= Math.abs(b - target) ? a : b) : target);
    }
    cuts.push(total);
    const chunks: AudioChunk[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const chunkPath = path.join(directory, `chunk-${String(i).padStart(3, "0")}.opus`);
      await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(cuts[i]), "-t", String(cuts[i + 1]! - cuts[i]!), "-i", normalized, "-c", "copy", chunkPath], { windowsHide: true, maxBuffer: 1024 * 1024 });
      chunks.push({ filePath: chunkPath, startSec: cuts[i]!, endSec: cuts[i + 1]! });
    }
    return { directory, chunks };
  } catch (err) {
    await rm(directory, { recursive: true, force: true });
    throw err;
  }
}
