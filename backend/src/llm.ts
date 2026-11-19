import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";
import { NEGATIVE_EMOTIONS, type Evidence, type ScoredSegment, type Scores } from "./emotion.js";
import { mockActionItems, mockToneVerdict } from "./mocks.js";

// GLM exposes an OpenAI-compatible API, so the official OpenAI SDK works with a different base URL.
const client = new OpenAI({
  baseURL: config.glm.baseUrl || undefined,
  apiKey: config.glm.apiKey || "mock",
  timeout: config.externalTimeoutMs,
  maxRetries: 0,
});

// ---------- Output schemas ----------

export const ActionItemsSchema = z.object({
  actionItems: z.array(
    z.object({
      owner: z.string(), // "Sales rep", "Customer", or a name
      task: z.string(),
      due: z.string().nullable(), // only if a deadline was mentioned
      quote: z.string(), // the words that created the action item
      timestamp: z.number().min(0), // seconds
    }),
  ),
});
export type ActionItems = z.infer<typeof ActionItemsSchema>;

const FlagSchema = z
  .object({
    timestamp: z.number().min(0),
    source: z.enum(["text", "voice"]),
    quote: z.string(),
    reason: z.string(),
  })
  // A voice flag must cite the emotion label and its score, e.g. "angry 0.72".
  .refine(
    (f) => f.source === "text" || (NEGATIVE_EMOTIONS.some((e) => f.reason.toLowerCase().includes(e)) && /\d\.\d/.test(f.reason)),
    { message: "voice flags must name the emotion label and its score (e.g. 'angry 0.72') in reason" },
  );

export const ToneVerdictSchema = z.object({
  verdict: z.enum(["GREEN", "RED"]),
  score: z.number().min(0).max(100), // confidence in the verdict, 0-100
  summary: z.string(),
  flags: z.array(FlagSchema),
});
export type ToneVerdict = z.infer<typeof ToneVerdictSchema>;

// ---------- Shared helper ----------

/** Ask for JSON, validate it with zod, and retry once (telling the model what was wrong). */
async function chatJson<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.chat.completions.create({
      model: config.glm.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
    });
    const text = config.injectGlmInvalidJson && attempt === 1 ? "not-json" : res.choices[0]?.message.content ?? "";
    try {
      // tolerate ```json fences around the object
      const json = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
      return schema.parse(json);
    } catch (err) {
      lastError = err instanceof z.ZodError ? z.prettifyError(err) : String(err);
      messages.push(
        { role: "assistant", content: text },
        { role: "user", content: `That reply was not valid: ${lastError}\nReply again with only the corrected JSON object.` },
      );
    }
  }
  throw new Error(`LLM returned invalid JSON twice: ${lastError.slice(0, 300)}`);
}

// ---------- LLM A: action items ----------

export interface Line {
  role: "REP" | "CUSTOMER";
  start: number;
  text: string;
}
const formatLines = (lines: Line[]) => lines.map((l) => `[${l.start.toFixed(1)}s] ${l.role}: ${l.text}`).join("\n");

export async function extractActionItems(lines: Line[]): Promise<ActionItems> {
  if (config.mockExternal) return mockActionItems(lines);

  const system = `You extract action items from sales call transcripts.
An action item is a concrete commitment or request that someone has to do after the call.
Reply with JSON only, in exactly this shape:
{"actionItems": [{"owner": string, "task": string, "due": string | null, "quote": string, "timestamp": number}]}
- owner: "Sales rep", "Customer", or the person's name if it is said.
- task: short imperative sentence.
- due: the deadline exactly as said ("Friday", "by end of month"), or null if none was mentioned. Never invent one.
- quote: the exact words from the transcript that created the item.
- timestamp: the [seconds] value of the line the quote comes from.
Return {"actionItems": []} if there are none.`;

  return chatJson(ActionItemsSchema, system, `Transcript (REP = sales rep, CUSTOMER = customer):\n${formatLines(lines)}`);
}

// ---------- LLM B: tone verdict ----------

export async function judgeTone(
  repLines: Line[],
  segments: ScoredSegment[],
  overall: Scores,
  evidence: Evidence[],
): Promise<ToneVerdict> {
  let verdict: ToneVerdict;
  if (config.mockExternal) {
    verdict = mockToneVerdict(repLines, evidence);
  } else {
    const system = `You review the sales rep's tone on a sales call. You get two independent signals:
1. TEXT: what the rep said.
2. VOICE: emotion2vec scores (0 to 1) for slices of the rep's audio, with timestamps.

Rules:
- Flag unprofessional wording (rude, dismissive, condescending, sarcastic, hostile, blaming the customer, cutting them off, profanity) even when the voice is calm. Use source "text".
- Flag a bad vocal tone (a clearly elevated negative emotion: ${NEGATIVE_EMOTIONS.join(", ")}; treat 0.5 or more as clearly elevated) even when the words are polite. Use source "voice".
- Do NOT average the two signals. Either one alone is enough to flag.
- A voice flag's reason must name the emotion label and its score, for example "angry 0.72".
- quote: the rep's exact words at that moment. timestamp: seconds from the start of the call.
- verdict: "RED" if there is at least one flag, otherwise "GREEN".
- score: your confidence in the verdict, 0 to 100.
- summary: two or three plain sentences explaining the verdict. Call the rep "the rep" (never "he" or "she").

Reply with JSON only, in exactly this shape:
{"verdict": "GREEN" | "RED", "score": number, "summary": string, "flags": [{"timestamp": number, "source": "text" | "voice", "quote": string, "reason": string}]}`;

    const voiceLines = segments.map((s) => {
      const neg = NEGATIVE_EMOTIONS.map((e) => `${e} ${(s.emotions[e] ?? 0).toFixed(2)}`).join(", ");
      return `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] neutral ${(s.emotions.neutral ?? 0).toFixed(2)}, ${neg} | "${s.text}"`;
    });

    const user = `REP TRANSCRIPT:
${formatLines(repLines)}

VOICE SCORES PER REP SEGMENT:
${voiceLines.join("\n") || "(no rep segments were long enough to score)"}

OVERALL VOICE SCORES (duration-weighted): ${JSON.stringify(overall)}
STRONGEST NEGATIVE VOICE MOMENTS: ${JSON.stringify(evidence)}`;

    verdict = await chatJson(ToneVerdictSchema, system, user);
  }

  // Either signal can flag: any flag at all makes the call RED.
  if (verdict.flags.length > 0) verdict.verdict = "RED";
  return verdict;
}
