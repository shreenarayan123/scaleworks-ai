import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { textOf, type Utterance } from "./segments.js";

export type Scores = Record<string, number>;
export const NEGATIVE_EMOTIONS = ["angry", "disgusted", "fearful", "sad"];

export interface ScoredSegment {
  start: number;
  end: number;
  text: string;
  emotions: Scores;
}

export interface Evidence {
  start: number;
  end: number;
  text: string;
  emotion: string; // the strongest negative emotion in this segment
  score: number;
}

const ServiceResponse = z.object({
  segments: z.array(z.object({ id: z.string(), start: z.number(), end: z.number(), scores: z.record(z.string(), z.number()) })),
});

/** Send the original audio plus the segment list; get emotion scores per segment back. */
export async function scoreSegments(filePath: string, segments: Utterance[]): Promise<ScoredSegment[]> {
  if (segments.length === 0) return [];

  const form = new FormData();
  form.append("audio", await openAsBlob(filePath), basename(filePath));
  form.append("segments", JSON.stringify(segments.map((s, i) => ({ id: String(i), start: s.start, end: s.end }))));

  const res = await fetch(`${config.emotionServiceUrl}/score`, {
    method: "POST",
    headers: config.emotionServiceToken ? { Authorization: `Bearer ${config.emotionServiceToken}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(config.externalTimeoutMs),
  });
  if (!res.ok) throw new Error(`Emotion service returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = ServiceResponse.parse(await res.json());
  return data.segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: textOf(segments[Number(s.id)]?.words ?? []),
    emotions: s.scores,
  }));
}

/** Duration-weighted average of each emotion over all segments. */
export function overallScores(segments: ScoredSegment[]): Scores {
  const totals: Scores = {};
  let totalDuration = 0;
  for (const s of segments) {
    const duration = s.end - s.start;
    totalDuration += duration;
    for (const [emotion, score] of Object.entries(s.emotions)) {
      totals[emotion] = (totals[emotion] ?? 0) + score * duration;
    }
  }
  const overall: Scores = {};
  for (const [emotion, sum] of Object.entries(totals)) {
    overall[emotion] = totalDuration > 0 ? Number((sum / totalDuration).toFixed(4)) : 0;
  }
  return overall;
}

/** The segments with the highest negative-emotion score, strongest first. */
export function negativeEvidence(segments: ScoredSegment[], limit = 5): Evidence[] {
  return segments
    .map((s) => {
      const [emotion, score] = NEGATIVE_EMOTIONS.map((e) => [e, s.emotions[e] ?? 0] as const).sort((a, b) => b[1] - a[1])[0]!;
      return { start: s.start, end: s.end, text: s.text, emotion, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
