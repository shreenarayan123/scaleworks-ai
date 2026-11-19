import { execFile } from "node:child_process";
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
