/**
 * Canned Scribe and GLM responses for MOCK_EXTERNAL=true, so the pipeline can run
 * without API keys. The emotion service is still called for real on the real audio.
 */
import type { Evidence } from "./emotion.js";
import type { AnalysisSettings } from "./analysis-settings.js";
import type { ActionItems, Line, ToneVerdict } from "./llm.js";
import type { Transcript } from "./scribe.js";
import type { TimedWord } from "./segments.js";

const SCRIPT: [speaker: string, text: string][] = [
  ["speaker_0", "Thanks for joining today. How has the pilot been going for your team?"],
  ["speaker_1", "Mostly good, but some custom fields are not syncing from our CRM."],
  ["speaker_0", "That is usually a configuration issue on your side. Let me stop you there, just follow the setup guide."],
  ["speaker_1", "We did follow it. Could someone take a look with us?"],
  ["speaker_0", "Okay. I'll send the permissions checklist after this call and confirm the pilot extension by Friday."],
  ["speaker_1", "Great, we will send the sync logs to support today."],
];

/** Spread the script's words evenly across the real file duration, with a short pause between turns. */
export function mockTranscript(durationSec: number): Transcript {
  const turnGap = 0.5;
  const turns = SCRIPT.map(([speaker, text]) => ({ speaker, tokens: text.split(" ") }));
  const wordCount = turns.reduce((n, t) => n + t.tokens.length, 0);
  const perWord = (durationSec - 0.2 - turnGap * turns.length) / wordCount;

  const words: TimedWord[] = [];
  let t = 0.2;
  for (const turn of turns) {
    for (const token of turn.tokens) {
      words.push({ text: token, start: t, end: t + perWord * 0.85, speaker: turn.speaker });
      t += perWord;
    }
    t += turnGap;
  }
  return { text: SCRIPT.map(([, text]) => text).join(" "), words };
}

export function mockActionItems(lines: Line[], settings: AnalysisSettings): ActionItems {
  const actionItems = lines
    .filter((l) => /\b(I'll|we will)\b/i.test(l.text) || (settings.includeImpliedCommitments && /\b(we should|let's|could you)\b/i.test(l.text)))
    .filter((l) => settings.includeCustomerRequests || l.role === "REP")
    .map((l) => ({
      owner: l.role === "REP" ? "Sales rep" : "Customer",
      task: l.text,
      due: l.text.match(/\b(today|by \w+day)\b/i)?.[0] ?? null,
      quote: l.text,
      timestamp: l.start,
      confidence: 0.9,
    }));
  return { actionItems };
}

export function mockToneVerdict(repLines: Line[], evidence: Evidence[], settings: AnalysisSettings): ToneVerdict {
  const flags: ToneVerdict["flags"] = [];
  const rules: Record<AnalysisSettings["negativeBehaviors"][number], RegExp> = {
    Rude: /\b(damn|fuck|idiot|stupid)\b/i,
    Hostile: /your side|your fault|fix it yourself/i,
    Dismissive: /just follow|read the (setup )?guide|basic questions/i,
    Sarcastic: /sure, because|right\?/i,
    Interrupting: /stop you there|let me stop you|i am talking now/i,
    Condescending: /clearly did not|basic questions|read the guide/i,
  };
  for (const line of repLines) {
    const matched = settings.negativeBehaviors.filter((behavior) => rules[behavior].test(line.text));
    if (matched.length) {
      flags.push({ timestamp: line.start, source: "text", quote: line.text, reason: `Matches enabled tone criteria: ${matched.join(", ")}.` });
    }
  }
  for (const e of evidence.filter((e) => e.score >= 0.5)) {
    flags.push({ timestamp: e.start, source: "voice", quote: e.text, reason: `Voice sounds ${e.emotion} ${e.score.toFixed(2)}.` });
  }
  return {
    verdict: flags.length > 0 ? "RED" : "GREEN",
    score: 80,
    summary: flags.length
      ? "[MOCK] The rep matched one or more enabled tone criteria or voice signals."
      : "[MOCK] No enabled tone criteria or elevated voice signals were detected.",
    flags,
  };
}
