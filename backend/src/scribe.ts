import { openAsBlob } from "node:fs";
import { z } from "zod";
import { config } from "./config.js";
import { mockTranscript } from "./mocks.js";
import type { TimedWord } from "./segments.js";

// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

const ScribeResponse = z.object({
  text: z.string(),
  words: z.array(
    z.object({
      text: z.string(),
      type: z.enum(["word", "spacing", "audio_event"]),
      start: z.number().nullish(),
      end: z.number().nullish(),
      speaker_id: z.string().nullish(),
    }),
  ),
});

export interface Transcript {
  text: string;
  words: TimedWord[];
}

/** Send the file to ElevenLabs Scribe with diarization and word timestamps. */
export async function transcribe(filePath: string, fileName: string, durationSec: number): Promise<Transcript> {
  if (config.mockExternal) return mockTranscript(durationSec);
  if (config.injectScribeTimeout) throw new Error("Injected Scribe timeout.");

  const form = new FormData();
  form.append("model_id", config.elevenLabs.modelId);
  form.append("diarize", "true");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  form.append("file", await openAsBlob(filePath), fileName);

  const res = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: { "xi-api-key": config.elevenLabs.apiKey },
    body: form,
    signal: AbortSignal.timeout(config.externalTimeoutMs),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`ElevenLabs Scribe returned ${res.status}: ${body}`);
  }

  const data = ScribeResponse.parse(await res.json());
  const words: TimedWord[] = data.words
    // keep real words only; "spacing" entries are the gaps between words
    .filter((w) => w.type === "word" && w.start != null && w.end != null)
    .map((w) => ({ text: w.text, start: w.start!, end: w.end!, speaker: w.speaker_id ?? "speaker_0" }));

  return { text: data.text, words };
}
