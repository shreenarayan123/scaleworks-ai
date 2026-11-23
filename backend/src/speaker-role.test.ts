import assert from "node:assert/strict";
import { test } from "node:test";
import { needsSpeakerConfirmation, publicRepCandidates, speakerEvidence, SPEAKER_CONFIRMATION } from "./speaker-role.js";

const at = (repLikelihood: number) => ({ repLikelihood });

test("a clear winner with high confidence skips confirmation", () => {
  assert.equal(needsSpeakerConfirmation([at(0.93), at(0.2)]), false);
});

test("a low top likelihood asks for confirmation even with a large gap", () => {
  assert.equal(needsSpeakerConfirmation([at(0.69), at(0.05)]), true);
});

test("a close runner-up asks for confirmation even when both are high", () => {
  assert.equal(needsSpeakerConfirmation([at(0.9), at(0.82)]), true);
});

test("exactly at the likelihood threshold is accepted", () => {
  assert.equal(needsSpeakerConfirmation([at(SPEAKER_CONFIRMATION.minLikelihood), at(0)]), false);
});

test("exactly at the gap threshold is accepted", () => {
  assert.equal(needsSpeakerConfirmation([at(0.8), at(0.8 - SPEAKER_CONFIRMATION.minGap)]), false);
});

test("a single speaker is never treated as ambiguous", () => {
  assert.equal(needsSpeakerConfirmation([at(0.75)]), false);
});

test("no candidates requires confirmation", () => {
  assert.equal(needsSpeakerConfirmation([]), true);
});

test("candidate order matters: unsorted input is judged on the first entry", () => {
  // Documents the pipeline contract: callers must sort descending first.
  assert.equal(needsSpeakerConfirmation([at(0.2), at(0.95)]), true);
});

// ---------- speakerEvidence ----------

const word = (text: string, start: number, end: number, speaker: string) => ({ text, start, end, speaker });

test("evidence keeps only the first five minutes", () => {
  const words = [
    word("Hello.", 0, 0.5, "speaker_0"),
    word("Late", 301, 301.4, "speaker_1"),
    word("turn.", 301.4, 302, "speaker_1"),
  ];
  const { excerpt } = speakerEvidence(words);
  assert.deepEqual(excerpt.map((line) => line.text), ["Hello."]);
});

test("evidence splits lines on punctuation and speaker change", () => {
  const words = [
    word("Hi", 0, 0.3, "speaker_0"),
    word("there.", 0.3, 0.8, "speaker_0"),
    word("Yes?", 1.5, 1.9, "speaker_1"),
  ];
  const { excerpt } = speakerEvidence(words);
  assert.deepEqual(excerpt.map((line) => [line.speaker, line.text]), [
    ["speaker_0", "Hi there."],
    ["speaker_1", "Yes?"],
  ]);
});

test("stats count questions and sum talk-time ratios to one", () => {
  const words = [
    word("How", 0, 0.4, "speaker_0"),
    word("are", 0.4, 0.6, "speaker_0"),
    word("you?", 0.6, 1.0, "speaker_0"),
    word("Fine,", 1.5, 2.0, "speaker_1"),
    word("thanks.", 2.0, 3.0, "speaker_1"),
  ];
  const { stats } = speakerEvidence(words);
  assert.equal(stats.speaker_0?.questionCount, 1);
  assert.equal(stats.speaker_1?.questionCount, 0);
  const total = (stats.speaker_0?.talkTimeRatio ?? 0) + (stats.speaker_1?.talkTimeRatio ?? 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("empty transcript yields no evidence and no stats", () => {
  assert.deepEqual(speakerEvidence([]), { excerpt: [], stats: {} });
});

// ---------- publicRepCandidates ----------

test("stored repLikelihood is exposed to clients as likelihood", () => {
  const stored = [{ speaker: "speaker_1", repLikelihood: 0.65, reasons: ["Steers the call"] }];
  assert.deepEqual(publicRepCandidates(stored), [{ speaker: "speaker_1", likelihood: 0.65, reasons: ["Steers the call"] }]);
});

test("already-normalized and legacy rows both pass through", () => {
  assert.deepEqual(
    publicRepCandidates([{ speaker: "speaker_0", likelihood: 0.9, reasons: [] }]),
    [{ speaker: "speaker_0", likelihood: 0.9, reasons: [] }],
  );
});

test("malformed candidates are dropped instead of crashing the endpoint", () => {
  assert.deepEqual(publicRepCandidates(null), []);
  assert.deepEqual(publicRepCandidates("nope"), []);
  assert.deepEqual(publicRepCandidates([null, 42, { reasons: [] }, { speaker: "speaker_0" }]), [
    { speaker: "speaker_0", likelihood: 0, reasons: [] },
  ]);
});


