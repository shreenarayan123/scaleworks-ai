import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateToneFindings,
  FindingSchema,
  parseJsonWithRetry,
  ToneFindingsResponseSchema,
  type ToneFinding,
} from "./llm.js";

const grounded = (confidence: number, overrides: Partial<ToneFinding> = {}): ToneFinding => ({
  ruleId: "builtin:rude",
  triggered: true,
  quote: "That is your problem.",
  startMs: 1200,
  source: "text",
  confidence,
  reason: "Dismissive wording",
  ...overrides,
});

test("grounded triggered finding at confidence 0.85 produces RED", () => {
  assert.equal(aggregateToneFindings([grounded(0.85)], "That is your problem.").verdict, "RED");
});

test("grounded triggered finding at confidence 0.79 produces GREEN for a soft rule", () => {
  assert.equal(aggregateToneFindings([grounded(0.79)], "That is your problem.").verdict, "GREEN");
});

test("hallucinated quote is discarded and cannot produce RED", () => {
  const result = aggregateToneFindings([grounded(0.99, { quote: "You promised a refund." })], "That is your problem.");
  assert.equal(result.verdict, "GREEN");
  assert.equal(result.findings.length, 0);
  assert.equal(result.flags.length, 0);
});

test("unknown custom rule ids are discarded", () => {
  const result = aggregateToneFindings([grounded(0.99, { ruleId: "custom:99" })], "That is your problem.", ["the rep pressures the customer"]);
  assert.equal(result.verdict, "GREEN");
  assert.equal(result.findings.length, 0);
});

test("non-triggered finding does not produce RED", () => {
  const result = aggregateToneFindings([grounded(1, { triggered: false })], "That is your problem.");
  assert.equal(result.verdict, "GREEN");
  assert.equal(result.flags.length, 0);
});

test("multiple findings aggregate using the highest applicable confidence", () => {
  assert.equal(aggregateToneFindings([grounded(0.79), grounded(0.85, { ruleId: "builtin:hostile" })], "That is your problem.").verdict, "RED");
  assert.equal(aggregateToneFindings([grounded(0.79), grounded(0.25, { ruleId: "custom:0" })], "That is your problem.", ["the rep pressures the customer"]).verdict, "RED");
  assert.match(aggregateToneFindings([grounded(0.25, { ruleId: "custom:0" })], "That is your problem.", ["the rep pressures the customer"]).flags[0]?.reason ?? "", /Custom rule 1: the rep pressures the customer/);
});

test("invalid structured JSON retries once then accepts valid output", async () => {
  let calls = 0;
  const result = await parseJsonWithRetry(ToneFindingsResponseSchema, async () => {
    calls++;
    return calls === 1 ? "not-json" : JSON.stringify({ findings: [grounded(0.85)] });
  }, "system", "user");
  assert.equal(calls, 2);
  assert.equal(result.findings.length, 1);
});

test("finding schema rejects missing and invalid fields", () => {
  assert.equal(FindingSchema.safeParse({ triggered: true }).success, false);
  assert.equal(FindingSchema.safeParse({ ...grounded(0.85), confidence: 1.2 }).success, false);
  assert.equal(FindingSchema.safeParse({ ...grounded(0.85), source: "audio" }).success, false);
  assert.equal(ToneFindingsResponseSchema.safeParse({ verdict: "RED", findings: [] }).success, false);
});

test("model response contains findings only; final verdict schema is backend output", () => {
  assert.equal(ToneFindingsResponseSchema.safeParse({ findings: [] }).success, true);
  assert.equal(ToneFindingsResponseSchema.safeParse({ findings: [], verdict: "RED" }).success, false);
  const result = aggregateToneFindings([grounded(0.85)], "That is your problem.");
  assert.equal(result.verdict, "RED");
});
