import assert from "node:assert/strict";
import { test } from "node:test";
import { lintToneRules, mockAiRuleCheck, validateToneRulesLocally } from "./llm.js";

test("local rule checks catch empty, short, imperative, duplicate, and length errors", async () => {
  assert.equal(validateToneRulesLocally([""]).length, 1);
  assert.match(validateToneRulesLocally(["Never interrupt the customer"]).map((p) => p.message).join(" "), /describe what to flag/i);
  assert.equal(validateToneRulesLocally(["the rep interrupts the customer", "The rep   interrupts the customer"]).length, 1);
  assert.equal((await lintToneRules(["the rep gives clear answers ".repeat(15)], [], mockAiRuleCheck)).problems.length, 1);
  assert.equal((await lintToneRules(Array.from({ length: 11 }, (_, i) => `the rep uses behavior number ${i}`), [], mockAiRuleCheck)).problems.length, 1);
});

test("local problems stop before the single AI check", async () => {
  let aiCalls = 0;
  const result = await lintToneRules([""], [], async () => { aiCalls++; return []; });
  assert.equal(aiCalls, 0);
  assert.equal(result.problems.length, 1);

  const valid = await lintToneRules(["the rep interrupts the customer"], [], async (rules) => {
    aiCalls++;
    assert.deepEqual(rules, ["the rep interrupts the customer"]);
    return [];
  });
  assert.equal(aiCalls, 1);
  assert.equal(valid.problems.length, 0);
});

test("successful AI lint results are cached for repeated rule lists", async () => {
  let aiCalls = 0;
  const aiCheck = async () => {
    aiCalls++;
    return [];
  };
  const rules = ["the rep interrupts the customer"];
  await lintToneRules(rules, [], aiCheck);
  await lintToneRules(rules, [], aiCheck);
  assert.equal(aiCalls, 1);
});

test("AI lint failure lets saving continue with a notice", async () => {
  const result = await lintToneRules(["the rep interrupts the customer"], [], async () => {
    throw new Error("lint service unavailable");
  });
  assert.equal(result.problems.length, 0);
  assert.match(result.notices[0]?.message ?? "", /couldn't check these rules/i);
});

test("twelve representative rule sets keep clear conflicts blocked and reasonable pairs allowed", async () => {
  const samples: { rules: string[]; problem: boolean }[] = [
    { rules: ["the rep is polite", "the rep is rude"], problem: true },
    { rules: ["the rep is respectful", "the rep is disrespectful"], problem: true },
    { rules: ["the rep is professional", "the rep is unprofessional"], problem: true },
    { rules: ["the rep should be professional"], problem: true },
    { rules: ["flag the call if it goes badly"], problem: true },
    { rules: ["flag the call if it is Monday"], problem: true },
    { rules: ["the rep is silent", "the rep talks too much"], problem: false },
    { rules: ["the rep asks clear questions", "the rep summarizes the customer's needs"], problem: false },
    { rules: ["the rep explains pricing clearly", "the rep confirms next steps"], problem: false },
    { rules: ["the rep uses polite language", "the rep asks discovery questions"], problem: false },
    { rules: ["the rep interrupts the customer", "the rep speaks calmly"], problem: false },
    { rules: ["the rep acknowledges the concern", "the rep offers a relevant solution"], problem: false },
  ];
  for (const sample of samples) {
    const result = await lintToneRules(sample.rules, [], mockAiRuleCheck);
    assert.equal(result.problems.length > 0, sample.problem, sample.rules.join(" / "));
  }
});

test("matching a selected built-in behavior shows a notice without blocking save", async () => {
  const result = await lintToneRules(["the rep interrupts the customer"], ["Interrupting"], async () => []);
  assert.equal(result.problems.length, 0);
  assert.equal(result.notices.length, 1);
});
