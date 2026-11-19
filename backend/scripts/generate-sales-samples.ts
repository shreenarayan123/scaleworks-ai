import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required.");

const modelId = process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_v3";
const outputDir = path.resolve(process.env.SALES_SAMPLE_DIR ?? "eval-results/sales-samples");
const configuredVoices = (process.env.ELEVENLABS_TTS_VOICE_IDS ?? "")
  .split(",").map((id) => id.trim()).filter(Boolean);

const clips = [
  {
    id: "green-flag-positive-sales-call",
    label: "Green flag: positive, consultative sales call with clear next steps",
    inputs: [
      { text: "Thanks for walking me through your team's workflow, Maya. It sounds like the biggest opportunity is cutting down the time your reps spend updating the CRM. Is that the right priority?", speaker: "sales_rep" },
      { text: "Yes. We want to make that easier, but we need to know it will fit our current process.", speaker: "prospect" },
      { text: "That makes sense. Based on what you shared, the CRM integration and the guided onboarding look like the best fit. I can show you both using a sample from your team's workflow, and we can check the fields together before you decide.", speaker: "sales_rep" },
      { text: "That would be useful. What should we do next?", speaker: "prospect" },
      { text: "I'll send a short recap and a calendar invite for a 30-minute workflow demo by the end of today. If you can bring one example record and your list of required CRM fields, we'll validate the setup live. After the demo, I'll send the recommended plan and a written onboarding timeline. No pressure to make a decision until your team has reviewed them.", speaker: "sales_rep" },
      { text: "Great. I'll invite our CRM admin and send over the fields before the demo.", speaker: "prospect" },
    ],
  },
  {
    id: "red-flag-negative-sales-call",
    label: "Red flag: pushy, dismissive sales behavior followed by concrete recovery actions",
    inputs: [
      { text: "We are interested, but our team is concerned the migration could disrupt our current CRM workflow.", speaker: "prospect" },
      { text: "You're overthinking it. Everyone migrates without a problem, and this discount is only available if you sign today. Let's get the order form done.", speaker: "sales_rep" },
      { text: "We still need to check the integration with our CRM admin. I don't want to commit before we know it works.", speaker: "prospect" },
      { text: "You don't need to hold this up for your admin. The integration is standard. Just approve it and we can figure out the details later.", speaker: "sales_rep" },
      { text: "That makes me less comfortable. We need a clear plan before making a decision.", speaker: "prospect" },
      { text: "You're right to ask for a plan. I pushed for a decision before addressing your risk, and that wasn't helpful. Here's what I'll do: today I'll send the integration documentation and a written summary of the migration steps. I'll schedule a technical review with your CRM admin, confirm your required fields and data safeguards, and share a rollout timeline with a rollback option. I'll also extend the quoted pricing through Friday so you can evaluate the fit without pressure. We can decide after the technical review.", speaker: "sales_rep" },
      { text: "That would address our concerns. Please send the documentation and a few times for the review.", speaker: "prospect" },
    ],
  },
];

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

const voices = await getVoices();
await mkdir(outputDir, { recursive: true });
const manifest = [];
for (const clip of clips) {
  const inputs = clip.inputs.map(({ text, speaker }) => ({
    text,
    voice_id: speaker === "sales_rep" ? voices[0]! : voices[1]!,
  }));
  const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
    method: "POST",
    headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
    body: JSON.stringify({ model_id: modelId, inputs, seed: clip.id.includes("green") ? 4101 : 4102 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Text-to-Dialogue failed for ${clip.id}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const mp3 = path.join(outputDir, `${clip.id}.mp3`);
  const wav = path.join(outputDir, `${clip.id}.wav`);
  await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  manifest.push({ id: clip.id, label: clip.label, inputs: clip.inputs, mp3, wav });
  console.log(`created ${clip.id}`);
}
await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ modelId, voices, clips: manifest }, null, 2));
