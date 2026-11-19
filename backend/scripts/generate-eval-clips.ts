import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required.");
const modelId = process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_v3";
const outputDir = path.resolve(process.env.EVAL_CLIP_DIR ?? "eval-results/clips");
const voiceIds = (process.env.ELEVENLABS_TTS_VOICE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);

type Clip = {
  id: string;
  textRed: boolean;
  voiceRed: boolean;
  notes: string;
  inputs: { text: string; voice_id: string }[];
};

const scripts: Omit<Clip, "inputs">[] = [
  { id: "01-calm-greeting", textRed: false, voiceRed: false, notes: "Calm, helpful opening." },
  { id: "02-polite-update", textRed: false, voiceRed: false, notes: "Polite status update." },
  { id: "03-calm-problem", textRed: false, voiceRed: false, notes: "Calm explanation of a sync issue." },
  { id: "04-blame", textRed: true, voiceRed: false, notes: "Blames the customer." },
  { id: "05-interruption", textRed: true, voiceRed: false, notes: "Cuts the customer off." },
  { id: "06-profanity", textRed: true, voiceRed: false, notes: "Uses profanity." },
  { id: "07-dismissive", textRed: true, voiceRed: false, notes: "Dismissive wording." },
  { id: "08-angry-polite", textRed: false, voiceRed: true, notes: "Polite words with angry delivery cue." },
  { id: "09-shouting-help", textRed: false, voiceRed: true, notes: "Helpful words with elevated delivery cue." },
  { id: "10-sad-apology", textRed: false, voiceRed: true, notes: "Apology with distressed delivery cue." },
  { id: "11-rude-angry", textRed: true, voiceRed: true, notes: "Both wording and delivery are negative." },
  { id: "12-sarcasm-neutral", textRed: true, voiceRed: false, notes: "Sarcastic wording with neutral cue." },
  { id: "13-action-item", textRed: false, voiceRed: false, notes: "Neutral commitment and next step." },
  { id: "14-urgent-angry", textRed: false, voiceRed: true, notes: "Urgent, raised delivery." },
  { id: "15-calm-low-volume", textRed: false, voiceRed: true, notes: "Manually labeled negative low-volume acting; known emotion2vec weak spot." },
];

const dialogue = [
  ["Thanks for joining today. How has the pilot been going?", "Good overall, but our CRM fields are not syncing."],
  ["The export is ready and I will send it this afternoon.", "Perfect, thank you for the update."],
  ["We found a configuration issue and can review it together.", "That would help us a lot."],
  ["That is your problem. You clearly did not follow the setup guide.", "We followed every step and need help."],
  ["Stop you there. I am talking now.", "I was only explaining the issue."],
  ["This is a damn waste of time. Fix it yourself.", "That response is not helpful."],
  ["I do not have time for basic questions. Read the documentation.", "We need a little more guidance."],
  ["[angry] I am happy to walk through the fix with you.", "Thank you, that sounds good."],
  ["[shouting] I can absolutely help you resolve this today!", "Okay, let us do that."],
  ["[sad] I am sorry this has been frustrating for your team.", "We appreciate the apology."],
  ["[angry] Stop wasting my time. This is your fault.", "We need a constructive plan."],
  ["Sure, because reading the guide always solves everything, right?", "That sounds sarcastic."],
  ["I will send the permissions checklist by Friday.", "We will send the sync logs today."],
  ["[excited] We need to solve this immediately and get everyone moving!", "Understood, we will prioritize it."],
  ["[whispering] I can help review the issue and find a path forward.", "Thank you for staying with us."],
];

async function getVoices() {
  if (voiceIds.length >= 2) return voiceIds.slice(0, 2);
  const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
  if (!response.ok) throw new Error(`ElevenLabs voices request failed: ${response.status}`);
  const data = (await response.json()) as { voices?: { voice_id: string }[] };
  const ids = data.voices?.map((voice) => voice.voice_id) ?? [];
  if (ids.length < 2) throw new Error("At least two ElevenLabs voices are required.");
  return ids.slice(0, 2);
}

const voices = await getVoices();
await mkdir(outputDir, { recursive: true });
const manifest: Clip[] = [];
for (const [index, script] of scripts.entries()) {
  const [rep, customer] = dialogue[index]!;
  const inputs = [
    { text: rep, voice_id: voices[0]! },
    { text: customer, voice_id: voices[1]! },
  ];
  const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ model_id: modelId, inputs, seed: 1000 + index }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Text-to-Dialogue failed for ${script.id}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const mp3 = path.join(outputDir, `${script.id}.mp3`);
  const wav = path.join(outputDir, `${script.id}.wav`);
  await writeFile(mp3, Buffer.from(await response.arrayBuffer()));
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  manifest.push({ ...script, inputs });
  console.log(`created ${script.id}`);
}
await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ modelId, voices, clips: manifest }, null, 2));
