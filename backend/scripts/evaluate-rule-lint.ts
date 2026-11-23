import { lintToneRules } from "../src/llm.js";

const samples: { name: string; rules: string[]; expectProblem: boolean }[] = [
  { name: "polite versus rude", rules: ["the rep is polite", "the rep is rude"], expectProblem: true },
  { name: "respectful versus disrespectful", rules: ["the rep is respectful", "the rep is disrespectful"], expectProblem: true },
  { name: "professional versus unprofessional", rules: ["the rep is professional", "the rep is unprofessional"], expectProblem: true },
  { name: "vague professional", rules: ["the rep should be professional"], expectProblem: true },
  { name: "vague call", rules: ["flag the call if it goes badly"], expectProblem: true },
  { name: "weekday", rules: ["flag the call if it is Monday"], expectProblem: true },
  { name: "silence and talk time", rules: ["the rep is silent", "the rep talks too much"], expectProblem: false },
  { name: "questions and summary", rules: ["the rep asks clear questions", "the rep summarizes the customer's needs"], expectProblem: false },
  { name: "pricing and next steps", rules: ["the rep explains pricing clearly", "the rep confirms next steps"], expectProblem: false },
  { name: "politeness and discovery", rules: ["the rep uses polite language", "the rep asks discovery questions"], expectProblem: false },
  { name: "interrupting and calm delivery", rules: ["the rep interrupts the customer", "the rep speaks calmly"], expectProblem: false },
  { name: "acknowledgement and solution", rules: ["the rep acknowledges the concern", "the rep offers a relevant solution"], expectProblem: false },
];

let failures = 0;
for (const sample of samples) {
  const result = await lintToneRules(sample.rules, []);
  const actualProblem = result.problems.length > 0;
  const passed = actualProblem === sample.expectProblem;
  console.log(`${passed ? "PASS" : "FAIL"} ${sample.name}${actualProblem ? `: ${result.problems.map((problem) => problem.message).join("; ")}` : ""}`);
  if (!passed) failures++;
}
console.log(`${samples.length - failures}/${samples.length} live rule-lint samples matched expectations.`);
if (failures) process.exitCode = 1;
