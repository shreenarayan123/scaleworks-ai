/**
 * Turn word-level timestamps into rep-only audio segments for tone scoring.
 * Pure functions: no I/O, easy to test.
 */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

export interface Utterance {
  speaker: string;
  start: number;
  end: number;
  words: TimedWord[];
}

export const RULES = {
  maxGapSec: 1.0, // split an utterance when the silence between words is longer than this
  padSec: 0.15, // add this much audio before and after each segment
  minSec: 1.5, // drop segments shorter than this (too short for emotion2vec)
  maxSec: 10, // chunk anything longer than this
};

export const textOf = (words: TimedWord[]) => words.map((w) => w.text).join(" ");

/** Merge consecutive words into utterances. Split on speaker change or a gap > maxGapSec. */
export function mergeWords(words: TimedWord[], maxGapSec = RULES.maxGapSec): Utterance[] {
  const utterances: Utterance[] = [];
  for (const word of words) {
    const last = utterances.at(-1);
    if (last && last.speaker === word.speaker && word.start - last.end <= maxGapSec) {
      last.words.push(word);
      last.end = word.end;
    } else {
      utterances.push({ speaker: word.speaker, start: word.start, end: word.end, words: [word] });
    }
  }
  return utterances;
}

/**
 * Like mergeWords, but also ends a line after a word ending in . ? or !
 * Gives the LLMs short lines, each with its own timestamp, so flags can point at the right moment.
 */
export function sentences(words: TimedWord[]): Utterance[] {
  const lines: Utterance[] = [];
  let current: Utterance | undefined;
  for (const word of words) {
    if (current && current.speaker === word.speaker && word.start - current.end <= RULES.maxGapSec) {
      current.words.push(word);
      current.end = word.end;
    } else {
      current = { speaker: word.speaker, start: word.start, end: word.end, words: [word] };
      lines.push(current);
    }
    if (/[.?!]["')\]]*$/.test(word.text)) current = undefined;
  }
  return lines;
}

const overlaps = (a: Utterance, b: Utterance) => a.start < b.end && b.start < a.end;

/** Split an utterance longer than maxSec into equal chunks, each at most maxSec long. */
function chunk(u: Utterance): Utterance[] {
  const duration = u.end - u.start;
  if (duration <= RULES.maxSec) return [u];
  const count = Math.ceil(duration / RULES.maxSec);
  const size = duration / count;
  return Array.from({ length: count }, (_, i) => {
    const start = u.start + i * size;
    const end = i === count - 1 ? u.end : start + size;
    // a word belongs to the chunk that contains its midpoint
    const words = u.words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= start && (mid < end || i === count - 1);
    });
    return { speaker: u.speaker, start, end, words };
  });
}

/**
 * Build the rep segments that get sent to the emotion service:
 * merge -> pad (clamped to the file) -> drop short -> drop overlaps with customer speech -> chunk long ones.
 */
export function buildRepSegments(words: TimedWord[], repSpeaker: string, durationSec: number): Utterance[] {
  const utterances = mergeWords(words);
  const customer = utterances.filter((u) => u.speaker !== repSpeaker);

  return utterances
    .filter((u) => u.speaker === repSpeaker)
    .map((u) => ({
      ...u,
      start: Math.max(0, u.start - RULES.padSec),
      end: Math.min(durationSec, u.end + RULES.padSec),
    }))
    .filter((u) => u.end - u.start >= RULES.minSec)
    .filter((u) => !customer.some((c) => overlaps(u, c)))
    .flatMap(chunk);
}
