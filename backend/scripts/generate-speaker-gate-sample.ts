import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required.");

const modelId = process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_v3";
const outputDir = path.resolve(process.env.SALES_SAMPLE_DIR ?? "eval-results/sales-samples");
const id = "speaker-gate-customer-first-ambiguous";
const minDurationSeconds = Number(process.env.MIN_SAMPLE_DURATION_SECONDS ?? 60);
const maxChunkChars = 1_700;
const configuredVoices = (process.env.ELEVENLABS_TTS_VOICE_IDS ?? "")
  .split(",").map((id) => id.trim()).filter(Boolean);

// The first voice is the customer because that person speaks first. For
// repeatable speaker order, set two voice IDs in backend/.env.
// The wording is intentionally similar for both speakers so the role gate has
// to make a real decision. The extended dialogue keeps the clip over a minute.
const dialogue = [
  {
    speaker: "customer",
    text: "Thanks for joining. Our group works with teams on onboarding and integrations, and we have a few options we would like to compare. We can start with how your team handles a rollout.",
  },
  {
    speaker: "salesperson",
    text: "Thanks. We work with teams on onboarding and integrations too. There are a few ways to handle a rollout. What does your group usually look for when comparing options?",
  },
  {
    speaker: "customer",
    text: "We usually compare the implementation steps, support model, and ownership after launch. Our team can share the timeline we use if that would help.",
  },
  {
    speaker: "salesperson",
    text: "That would be useful. We can compare timelines and responsibilities side by side. Our team can also walk through the support options and send a short summary afterward.",
  },
  {
    speaker: "customer",
    text: "Before we go further, could you tell us how your team handles handoffs between the first call and the technical review? We have seen both clear and confusing versions of that.",
  },
  {
    speaker: "salesperson",
    text: "We assign one owner who keeps the notes from the first call and carries them into the technical review. What has your group seen that made a handoff confusing?",
  },
  {
    speaker: "customer",
    text: "In a comparison we did last quarter, the notes were short and the second team asked for the same background again. We would rather send our own outline so nothing gets lost in the middle.",
  },
  {
    speaker: "salesperson",
    text: "Please do. We can work from your outline and add a checklist so both sides see the same requirements. Which parts of the rollout matter most to your group?",
  },
  {
    speaker: "customer",
    text: "The timing and the support window after launch. Our team has limited coverage in the evenings, so we need to know what happens if something comes up outside those hours.",
  },
  {
    speaker: "salesperson",
    text: "We can document the coverage window and the escalation path before any decision. Would it help if we put the options in writing so your group can review them at its own pace?",
  },
  {
    speaker: "customer",
    text: "Yes, that would help. Please include the implementation steps and who owns each one, because our internal review asks for that level of detail every time.",
  },
  {
    speaker: "salesperson",
    text: "We will. We will send one short document with the steps, the owners, and the support details, and then we can answer any questions your team has on the next call.",
  },
] as const;

type Turn = { speaker: "customer" | "salesperson"; text: string };

function chunksOf(turns: readonly Turn[]): Turn[][] {
  const chunks: Turn[][] = [];
  let chunk: Turn[] = [];
  let chars = 0;
  for (const turn of turns) {
    if (chunk.length && chars + turn.text.length > maxChunkChars) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push({ speaker: turn.speaker, text: turn.text });
    chars += turn.text.length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function getVoices(): Promise<string[]> {
  if (configuredVoices.length >= 2) return configuredVoices.slice(0, 2);
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey! },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs voices request failed: ${response.status}`);
  const data = await response.json() as { voices?: { voice_id: string }[] };
  const ids = data.voices?.map((voice) => voice.voice_id) ?? [];
  if (ids.length < 2) throw new Error("At least two ElevenLabs voices are required.");
  return ids.slice(0, 2);
}

async function durationOf(file: string): Promise<number> {
  const info = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  return Number(info.stdout.trim());
}

async function main() {
  const voices = await getVoices();
  const chunks = chunksOf(dialogue);
  await mkdir(outputDir, { recursive: true });
  const partDir = path.join(outputDir, `${id}-parts`);
  await mkdir(partDir, { recursive: true });
  const priorParts = new Set(await readdir(partDir));

  for (let start = 0; start < chunks.length; start += 2) {
    const batch = chunks.slice(start, start + 2);
    await Promise.all(batch.map(async (_, offset) => {
      const i = start + offset;
      const partName = `${String(i + 1).padStart(3, "0")}.mp3`;
      if (priorParts.has(partName)) {
        console.log(`reusing part ${i + 1}/${chunks.length}`);
        return;
      }
      const inputs = chunks[i]!.map(({ speaker, text }) => ({
        text,
        voice_id: speaker === "customer" ? voices[0]! : voices[1]!,
      }));
      const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
        method: "POST",
        headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
        body: JSON.stringify({
          model_id: modelId,
          inputs,
          seed: 74102,
          output_format: "mp3_44100_128",
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        throw new Error(`ElevenLabs text-to-dialogue failed on part ${i + 1}/${chunks.length}: ${response.status} ${(await response.text()).slice(0, 300)}`);
      }
      await writeFile(path.join(partDir, partName), Buffer.from(await response.arrayBuffer()));
      console.log(`generated part ${i + 1}/${chunks.length}`);
    }));
  }

  const availableParts = (await readdir(partDir))
    .filter((name) => /^\d{3}\.mp3$/.test(name)).sort();
  if (availableParts.length !== chunks.length) {
    throw new Error(`Expected ${chunks.length} audio parts, found ${availableParts.length}. Remove ${partDir} and rerun.`);
  }

  const concatList = path.join(partDir, "concat.txt");
  await writeFile(concatList, availableParts.map((name) => `file '${name}'`).join("\n"));
  const rawMp3 = path.join(outputDir, `${id}-raw.mp3`);
  await execFileAsync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
    "-i", concatList, "-c", "copy", rawMp3,
  ], { cwd: partDir });

  const mp3 = path.join(outputDir, `${id}.mp3`);
  await execFileAsync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", rawMp3,
    "-c:a", "libmp3lame", "-b:a", "128k", mp3,
  ]);
  const wav = path.join(outputDir, `${id}.wav`);
  await execFileAsync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", mp3,
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav,
  ]);

  const duration = await durationOf(wav);
  if (!Number.isFinite(duration) || duration < minDurationSeconds) {
    throw new Error(`Generated sample is ${duration.toFixed(1)}s, below the required ${minDurationSeconds}s. Add more dialogue turns and rerun.`);
  }

  await writeFile(path.join(outputDir, `${id}.json`), JSON.stringify({
    id,
    purpose: "Exercise the needs_speaker_confirmation flow with a customer-first, intentionally role-ambiguous two-speaker clip that is longer than one minute.",
    expectedRoles: { firstVoice: "Customer", secondVoice: "Salesperson" },
    voices: { customer: voices[0], salesperson: voices[1] },
    modelId,
    durationSeconds: Number(duration.toFixed(2)),
    dialogue,
    files: { mp3, wav },
    note: "The confidence gate is model-driven. Upload the WAV and confirm that the call reaches Needs confirmation, or that the first voice is identified as the customer. A model update or different voice choice can change that outcome.",
  }, null, 2));
  console.log(`Created ${wav} (${duration.toFixed(1)}s)`);
  console.log(`Answer key: speaker 1 is Customer; speaker 2 is Salesperson.`);
}

await main();
