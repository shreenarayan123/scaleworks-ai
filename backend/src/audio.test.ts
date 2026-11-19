import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { audioDurationSec, isSupportedAudioFile } from "./audio.js";

const execFile = promisify(execFileCallback);

function oneSecondStereoWav(): Buffer {
  const dataSize = 44_100 * 2 * 2; // 44.1 kHz, two channels, 16-bit samples
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44_100, 24);
  wav.writeUInt32LE(176_400, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

test("accepts all supported audio extensions case-insensitively", () => {
  for (const extension of ["wav", "mp3", "m4a", "mp4", "ogg", "opus"]) {
    assert.equal(isSupportedAudioFile(`call.${extension}`), true);
    assert.equal(isSupportedAudioFile(`CALL.${extension.toUpperCase()}`), true);
  }
  assert.equal(isSupportedAudioFile("call.flac"), false);
});

test("probes a 44.1 kHz stereo WAV", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "emotion2vec-audio-"));
  const file = path.join(dir, "stereo.wav");
  try {
    await writeFile(file, oneSecondStereoWav());
    assert.ok(Math.abs(await audioDurationSec(file) - 1) < 0.01);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probes MP3, M4A, MP4, OGG, and OPUS audio", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "emotion2vec-formats-"));
  const outputs: { name: string; encoder: string; sampleRate: number }[] = [
    { name: "sample.mp3", encoder: "libmp3lame", sampleRate: 44_100 },
    { name: "sample.m4a", encoder: "aac", sampleRate: 44_100 },
    { name: "sample.mp4", encoder: "aac", sampleRate: 44_100 },
    { name: "sample.ogg", encoder: "libvorbis", sampleRate: 44_100 },
    { name: "sample.opus", encoder: "libopus", sampleRate: 48_000 },
  ];
  try {
    for (const { name, encoder, sampleRate } of outputs) {
      const file = path.join(dir, name);
      await execFile("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:duration=0.5",
        "-ar", String(sampleRate), "-ac", "2", "-c:a", encoder, "-y", file,
      ], { windowsHide: true });
      assert.ok((await audioDurationSec(file)) > 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a corrupt recording", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "emotion2vec-corrupt-"));
  const file = path.join(dir, "corrupt.mp3");
  try {
    await writeFile(file, Buffer.from("not a real audio file"));
    await assert.rejects(audioDurationSec(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
