/**
 * Pure helpers for the sales-rep role decision.
 *
 * The pipeline feeds these the Scribe word stream, then sends the result to
 * the LLM. Keeping them pure makes the decision reproducible and testable.
 */
import { sentences, textOf, type TimedWord } from "./segments.js";

export const SPEAKER_CONFIRMATION = {
  /** Below this top likelihood, always ask a human. */
  minLikelihood: 0.7,
  /** If the runner-up is this close, the call is ambiguous. */
  minGap: 0.12,
} as const;

export interface RepCandidate {
  repLikelihood: number;
}

export interface SpeakerLine {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface SpeakerStats {
  questionCount: number;
  talkTimeRatio: number;
}

export interface PublicRepCandidate {
  speaker: string;
  likelihood: number;
  reasons: string[];
}

/**
 * Normalize stored rep candidates for the API.
 *
 * The pipeline stores the classifier's `repLikelihood`; clients read
 * `likelihood`. Older jobs also used the raw field name, so accept both.
 */
export function publicRepCandidates(value: unknown): PublicRepCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { speaker, repLikelihood, likelihood, reasons } = entry as Record<string, unknown>;
    if (typeof speaker !== "string") return [];
    const score = typeof likelihood === "number" ? likelihood : typeof repLikelihood === "number" ? repLikelihood : 0;
    return [{
      speaker,
      likelihood: score,
      reasons: Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === "string") : [],
    }];
  });
}

/**
 * Candidates must already be sorted by descending repLikelihood.
 * Returns true when the pipeline should stop and ask the user to confirm.
 */
export function needsSpeakerConfirmation(candidates: RepCandidate[]): boolean {
  const best = candidates[0];
  if (!best) return true;
  const gap = best.repLikelihood - (candidates[1]?.repLikelihood ?? 0);
  return best.repLikelihood < SPEAKER_CONFIRMATION.minLikelihood
    || (candidates.length > 1 && gap < SPEAKER_CONFIRMATION.minGap);
}

/**
 * Build the evidence the role classifier sees: sentence-level lines from the
 * first five minutes, plus cheap per-speaker tiebreak signals.
 */
export function speakerEvidence(words: TimedWord[]): { excerpt: SpeakerLine[]; stats: Record<string, SpeakerStats> } {
  const excerpt = sentences(words)
    .filter((line) => line.start <= 300)
    .map((line) => ({ speaker: line.speaker, start: line.start, end: line.end, text: textOf(line.words) }));
  const totalTalk = excerpt.reduce((sum, line) => sum + (line.end - line.start), 0);
  const stats = Object.fromEntries([...new Set(excerpt.map((line) => line.speaker))].map((speaker) => {
    const own = excerpt.filter((line) => line.speaker === speaker);
    return [speaker, {
      questionCount: own.reduce((count, line) => count + (line.text.match(/\?/g)?.length ?? 0), 0),
      talkTimeRatio: totalTalk > 0 ? own.reduce((sum, line) => sum + line.end - line.start, 0) / totalTalk : 0,
    }];
  }));
  return { excerpt, stats };
}
