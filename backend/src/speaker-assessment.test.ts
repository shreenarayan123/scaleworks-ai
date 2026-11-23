/**
 * Offline tests for the role classifier's deterministic mock path.
 * MOCK_EXTERNAL must be set before ./llm.js is imported because config reads it once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MOCK_EXTERNAL = "true";
const { assessSpeakers } = await import("./llm.js");

const line = (speaker: string, start: number, text: string) => ({ speaker, start, text });

function statsFor(lines: { speaker: string; start: number; text: string }[]) {
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const total = lines.length;
  return Object.fromEntries(speakers.map((speaker) => {
    const own = lines.filter((l) => l.speaker === speaker);
    return [speaker, {
      questionCount: own.reduce((n, l) => n + (l.text.match(/\?/g)?.length ?? 0), 0),
      talkTimeRatio: own.length / total,
    }];
  }));
}

test("prefers the speaker who runs the sales conversation", async () => {
  const lines = [
    line("speaker_0", 0, "Thanks for calling. How has the pilot been for your team?"),
    line("speaker_1", 5, "It has been okay, but our CRM sync is broken."),
    line("speaker_0", 10, "Our product team can look at that with you today."),
  ];
  const result = await assessSpeakers(lines, statsFor(lines));
  assert.equal(result[0]?.speaker, "speaker_0");
  assert.ok((result[0]?.repLikelihood ?? 0) > (result[1]?.repLikelihood ?? 0));
});

test("returns exactly one assessment per supplied speaker, sorted descending", async () => {
  const lines = [
    line("speaker_0", 0, "Okay, I see."),
    line("speaker_1", 3, "Thanks for calling. Our company offers a pilot program."),
    line("speaker_2", 6, "I am just listening in."),
  ];
  const result = await assessSpeakers(lines, statsFor(lines));
  assert.deepEqual([...result.map((r) => r.speaker)].sort(), ["speaker_0", "speaker_1", "speaker_2"]);
  const scores = result.map((r) => r.repLikelihood);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("likelihoods are bounded to the documented 0..1 range", async () => {
  const lines = [
    line("speaker_0", 0, "Thanks for calling. Our company product. Is this a good time? Let's start today's agenda."),
    line("speaker_1", 5, "Yes."),
  ];
  const result = await assessSpeakers(lines, statsFor(lines));
  for (const candidate of result) {
    assert.ok(candidate.repLikelihood >= 0 && candidate.repLikelihood <= 1);
  }
});

test("reasons explain the decision instead of only a score", async () => {
  const lines = [
    line("speaker_0", 0, "Thanks for calling."),
    line("speaker_1", 3, "Hello."),
  ];
  const result = await assessSpeakers(lines, statsFor(lines));
  assert.ok((result[0]?.reasons.length ?? 0) > 0);
});

test("an empty transcript produces no assessments", async () => {
  assert.deepEqual(await assessSpeakers([], {}), []);
});
