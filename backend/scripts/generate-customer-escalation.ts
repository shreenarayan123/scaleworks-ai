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

const dialogue = [
  ["Sales Rep", "Hello, good morning. This is Alex from TechSolutions. Am I speaking with Mr. John?"],
  ["Customer", "Yes, hello. This is John. I was actually waiting for your call. I'm having some problems with the software you guys sold me."],
  ["Sales Rep", "Again? Seriously? We already discussed this yesterday. I don't understand what's so difficult about following the instructions."],
  ["Customer", "Well, I'm sorry, but I tried following them. The dashboard keeps showing an error, and I don't really understand what I'm supposed to do next."],
  ["Sales Rep", "Okay, listen. I've explained this at least three times now. You need to go to settings, click on integrations, and connect your account. It's not rocket science!"],
  ["Customer", "Right, right. So I go to settings, and then integrations? But I see two options here. One says API integration and the other says account integration. Which one should I select?"],
  ["Sales Rep", "Oh my God! How many times do I have to repeat myself? Select account integration! I've literally just told you that."],
  ["Customer", "Okay, please don't get upset. I'm just trying to make sure I don't select the wrong option because last time I did that, my account stopped working."],
  ["Sales Rep", "Well, that's because you weren't paying attention! We can't keep spending hours on something this basic. I have other clients to deal with as well."],
  ["Customer", "I understand you're busy, but I'm paying for this service. I expected someone to help me properly. I haven't been able to use the software for almost four days."],
  ["Sales Rep", "And we've already provided support! What else do you expect us to do? We can't sit here and hold your hand through every single click."],
  ["Customer", "I don't think that's fair. Nobody explained the setup process properly during onboarding. I was told everything would work automatically."],
  ["Sales Rep", "That's not what we promised. You clearly misunderstood what the sales team explained to you."],
  ["Customer", "But your sales representative specifically said the integration would take five minutes. It's been four days now."],
] as const;

async function getVoices() {
  if (configuredVoices.length >= 2) return configuredVoices.slice(0, 2);
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey! }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs voices request failed: ${response.status}`);
  const data = await response.json() as { voices?: { voice_id: string }[] };
  const ids = data.voices?.map(({ voice_id }) => voice_id) ?? [];
  if (ids.length < 2) throw new Error("At least two ElevenLabs voices are required.");
  return ids.slice(0, 2);
}

const voices = await getVoices();
let repTurn = 0;
const inputs = dialogue.map(([speaker, text]) => {
  if (speaker === "Customer") return { text, voice_id: voices[1]! };
  const turn = repTurn++;
  const delivery = turn === 0
    ? "[irritated, high-pitched, tense voice]"
    : turn === 2 || turn === 3 || turn === 4 || turn === 5 || turn === 6
      ? "[angry, high-pitched, sharp tone]"
      : "[angry, raised voice, sharp tone]";
  const emphasis = turn === 2 || turn === 3 || turn === 5
    ? "[shouts] "
    : "";
  return { text: `${delivery} ${emphasis}${text}`, voice_id: voices[0]! };
});
const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
  method: "POST",
  headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
  body: JSON.stringify({ model_id: modelId, inputs, seed: 4103 }),
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok) throw new Error(`Text-to-Dialogue failed: ${response.status} ${(await response.text()).slice(0, 300)}`);

await mkdir(outputDir, { recursive: true });
const id = "customer-escalation-red-flag";
const mp3 = path.join(outputDir, `${id}.mp3`);
const wav = path.join(outputDir, `${id}.wav`);
await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
await writeFile(path.join(outputDir, `${id}.json`), JSON.stringify({
  id,
  label: "Red flag: customer support call with hostile, dismissive, high-pitched sales rep delivery",
  modelId,
  voices,
  dialogue: dialogue.map(([speaker, text]) => ({ speaker, text })),
  deliveryDirection: "Sales rep lines use ElevenLabs audio tags for irritated, angry, high-pitched, raised and sometimes shouted delivery. Customer remains neutral.",
}, null, 2));
console.log(`created ${id}`);
