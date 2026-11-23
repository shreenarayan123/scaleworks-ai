/**
 * Evaluate the sales-rep role decision against labeled transcripts.
 *
 * This calls the same code the pipeline uses:
 *   speakerEvidence()  -> builds the 5-minute excerpt + tiebreak stats
 *   assessSpeakers()   -> real GLM call (no Scribe, so no transcription cost)
 *   needsSpeakerConfirmation() -> the production confidence gate
 *
 * Run from backend/ with real credentials:
 *   npx tsx scripts/evaluate-rep-speaker.ts
 *
 * The 15 base dialogues mirror eval-results/clips, where speaker_0 is the rep.
 * Each base scenario is also run with the speaker IDs swapped to measure
 * position bias. Adversarial scenarios probe the known weak spots.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { assessSpeakers } from "../src/llm.js";
import type { TimedWord } from "../src/segments.js";
import { needsSpeakerConfirmation, speakerEvidence, SPEAKER_CONFIRMATION } from "../src/speaker-role.js";

if (config.mockExternal) {
  console.error("This evaluation needs real GLM credentials. Set MOCK_EXTERNAL=false in backend/.env.");
  process.exit(1);
}

type Turn = [speaker: string, text: string];
interface Scenario {
  id: string;
  expectedRep: string | null;
  ambiguous?: boolean;
  informational?: boolean;
  notes: string;
  turns: Turn[];
}

// Same 15 dialogues as scripts/generate-eval-clips.ts. [rep, customer].
const BASE_DIALOGUES: [string, string][] = [
  ["Thanks for joining today. How has the pilot been going?", "Good overall, but our CRM fields are not syncing."],
  ["The export is ready and I will send it this afternoon.", "Perfect, thank you for the update."],
  ["We found a configuration issue and can review it together.", "That would help us a lot."],
  ["That is your problem. You clearly did not follow the setup guide.", "We followed every step and need help."],
  ["Stop you there. I am talking now.", "I was only explaining the issue."],
  ["This is a damn waste of time. Fix it yourself.", "That response is not helpful."],
  ["I do not have time for basic questions. Read the documentation.", "We need a little more guidance."],
  ["I am happy to walk through the fix with you.", "Thank you, that sounds good."],
  ["I can absolutely help you resolve this today!", "Okay, let us do that."],
  ["I am sorry this has been frustrating for your team.", "We appreciate the apology."],
  ["Stop wasting my time. This is your fault.", "We need a constructive plan."],
  ["Sure, because reading the guide always solves everything, right?", "That sounds sarcastic."],
  ["I will send the permissions checklist by Friday.", "We will send the sync logs today."],
  ["We need to solve this immediately and get everyone moving!", "Understood, we will prioritize it."],
  ["I can help review the issue and find a path forward.", "Thank you for staying with us."],
];

const baseScenarios: Scenario[] = BASE_DIALOGUES.map(([rep, customer], index) => ({
  id: `base-${String(index + 1).padStart(2, "0")}`,
  expectedRep: "speaker_0",
  notes: "Labeled eval dialogue: speaker_0 is the rep.",
  turns: [["speaker_0", rep], ["speaker_1", customer]],
}));

const swappedScenarios: Scenario[] = BASE_DIALOGUES.map(([rep, customer], index) => ({
  id: `swapped-${String(index + 1).padStart(2, "0")}`,
  expectedRep: "speaker_1",
  notes: "Same dialogue with IDs swapped: rep is speaker_1.",
  turns: [["speaker_1", rep], ["speaker_0", customer]],
}));

const adversarial: Scenario[] = [
  {
    id: "adv-quiet-rep",
    expectedRep: "speaker_0",
    notes: "Rep gives one-word answers; customer monologues.",
    turns: [
      ["speaker_1", "So we have been on the platform for about eight months now. The rollout went well at first, but since the last release our nightly imports fail, the dashboard is stale, and two of our teams have stopped trusting the numbers."],
      ["speaker_0", "Okay."],
      ["speaker_1", "We have raised this three times with support. Each time we get a different answer, and honestly it is costing us credibility internally."],
      ["speaker_0", "I can check that."],
      ["speaker_1", "What we need is someone who owns this end to end and gives us a real timeline, not another ticket."],
      ["speaker_0", "Sure."],
    ],
  },
  {
    id: "adv-customer-leads",
    expectedRep: "speaker_1",
    notes: "Customer asks discovery-style questions; rep answers with product detail.",
    turns: [
      ["speaker_0", "Before we talk pricing, what exactly does your onboarding include, and how long does it usually take?"],
      ["speaker_1", "Our onboarding includes data migration, a permissions review, and two training sessions. Most teams are live in three weeks."],
      ["speaker_0", "And how does your product handle custom fields that change often?"],
      ["speaker_1", "Our platform maps custom fields automatically and re-syncs them whenever the schema changes."],
      ["speaker_0", "What about support after go-live?"],
      ["speaker_1", "You get a named success manager and a shared channel with our support team."],
    ],
  },
  {
    id: "adv-no-sales-cues",
    expectedRep: "speaker_0",
    notes: "Rep never introduces the company or leads; purely reactive.",
    turns: [
      ["speaker_1", "I want to explain what happened with the invoice."],
      ["speaker_0", "Okay."],
      ["speaker_1", "We were charged twice in October, and the credit never appeared."],
      ["speaker_0", "Let me look."],
      ["speaker_1", "Also, the renewal quote came in higher than we agreed."],
      ["speaker_0", "I see."],
    ],
  },
  {
    id: "adv-both-salesy",
    expectedRep: null,
    ambiguous: true,
    notes: "Two vendor reps comparing notes; both use sales language. Gate should fire.",
    turns: [
      ["speaker_0", "Thanks for joining. Our product team offers a shared pilot with your company."],
      ["speaker_1", "Great. We offer a similar program, and our company can lead the agenda today."],
      ["speaker_0", "Perfect. Let's start with our discovery questions and next steps."],
      ["speaker_1", "Agreed. Is this a good time to walk through our pricing tiers?"],
    ],
  },
  {
    id: "adv-three-speakers",
    expectedRep: "speaker_0",
    notes: "Rep, customer, and a manager who says one line.",
    turns: [
      ["speaker_0", "Thanks for joining. I run the pilot for our product team."],
      ["speaker_1", "Thanks. I own the CRM integration on our side."],
      ["speaker_2", "I am the director here, just listening in."],
      ["speaker_0", "Happy to have you. I will walk through the setup and next steps."],
    ],
  },
  {
    id: "adv-customer-first-three-speakers",
    expectedRep: "speaker_2",
    notes: "Customer opens, then the rep joins a call with a customer-side manager; three speakers total.",
    turns: [
      ["speaker_0", "Thanks for making time. I want to start with the renewal quote because the new platform fee was not in our original agreement. Can we get an explanation and a written breakdown?"],
      ["speaker_1", "I manage the account internally. We need to understand whether this changes the budget we already approved."],
      ["speaker_2", "Thanks for laying that out. I am your account representative, and I will review the signed order form and invoice with our billing team. I will send you an itemized explanation by Thursday."],
      ["speaker_0", "Please include the usage charges too; those are also different from the estimate."],
      ["speaker_1", "And copy me so I can update the finance team."],
      ["speaker_2", "Absolutely. I will include both items and copy you on the written summary."],
    ],
  },
  {
    id: "adv-customer-first-four-speakers-late-rep",
    expectedRep: "speaker_3",
    notes: "Customer opens, two customer-side colleagues speak, and the rep joins fourth; four speakers total.",
    turns: [
      ["speaker_0", "Thanks for joining. The integration has dropped records every night this week, so we need to agree on a recovery plan before discussing renewal."],
      ["speaker_1", "I run operations. We have reconciled the missing records manually, but we cannot keep doing that."],
      ["speaker_2", "I am from IT. The connector logs show repeated authentication failures after the last update."],
      ["speaker_3", "I am the account representative. I will coordinate engineering and support, get the connector logs reviewed today, and send one owner and a recovery timeline by tomorrow morning."],
      ["speaker_0", "Please make sure the plan covers the records already missed, not only preventing another failure."],
      ["speaker_3", "Understood. I will include a backfill plan and confirm which records can be restored."],
    ],
  },
  {
    id: "adv-customer-first-three-speakers-rep-second",
    expectedRep: "speaker_1",
    notes: "Customer speaks first; rep is speaker_1 and a customer-side director enters later; three speakers total.",
    turns: [
      ["speaker_0", "I want to understand the onboarding timeline and what our team needs to prepare before we sign."],
      ["speaker_1", "I lead onboarding for our team. We start with a data and permissions review, then run two training sessions. If you share your user list this week, I can send a project plan with owners and dates."],
      ["speaker_2", "I am the director approving the purchase. What happens if the data migration uncovers missing fields?"],
      ["speaker_1", "We map those fields with your administrator before launch, document any gaps, and agree on a workaround before migration. I will include that checkpoint in the project plan."],
      ["speaker_0", "That answers it. Please send the plan so we can review it internally."],
    ],
  },
  {
    id: "adv-rep-joins-late",
    expectedRep: "speaker_0",
    notes: "First ~4 minutes are IVR and a customer monologue; rep enters near the 5-minute cutoff.",
    turns: [
      ["speaker_2", "Thank you for calling. Press one for sales, two for support, or stay on the line."],
      ["speaker_1", "I have been waiting for a while. Let me describe the whole situation before anyone picks up. We signed in January, the rollout was delayed twice, the integration still drops records, and our finance team cannot reconcile the usage report. I have notes from every call and I want to go through them in order."],
      ["speaker_1", "The first issue started in March, then again in April, and nobody followed up. I have emailed support four times and opened two tickets. I am documenting everything because I need a resolution this week."],
      ["speaker_1", "Honestly, I am close to escalating this to our procurement team and reviewing alternatives."],
      ["speaker_0", "Hi, this is the sales team. I have your account open and I can own this from here."],
    ],
  },
  {
    id: "adv-swapped-position",
    expectedRep: "speaker_1",
    notes: "Clear sales-led dialogue with the rep as the second speaker.",
    turns: [
      ["speaker_0", "Hello, we have a problem with the sync."],
      ["speaker_1", "Thanks for calling. I can help with that. Our product team handles sync issues, and I will walk you through the fix today."],
      ["speaker_0", "That would be great."],
      ["speaker_1", "Let's start with your setup, then I will send the checklist after this call."],
    ],
  },
  {
    id: "adv-hinglish-sales",
    expectedRep: "speaker_0",
    informational: true,
    notes: "Informational: Hinglish sales call, common in the target market.",
    turns: [
      ["speaker_0", "Thank you for joining. Main aapko product ke baare mein quickly batata hoon, phir aapke questions lete hain."],
      ["speaker_1", "Haan theek hai, humein pricing aur onboarding dono jaanna hai."],
      ["speaker_0", "Bilkul. Hamara onboarding three weeks mein complete hota hai, aur main aapko checklist bhej doonga."],
      ["speaker_1", "Okay, aur support ka kya process hai?"],
    ],
  },
];

/** Turn text -> word-level timings, so the real speakerEvidence() code runs. */
function toWords(turns: Turn[], wordSec = 0.32, gapSec = 0.5): TimedWord[] {
  const words: TimedWord[] = [];
  let t = 0;
  for (const [speaker, text] of turns) {
    for (const token of text.split(/\s+/).filter(Boolean)) {
      words.push({ text: token, start: t, end: t + wordSec * 0.85, speaker });
      t += wordSec;
    }
    t += gapSec;
  }
  return words;
}

interface Row {
  id: string;
  notes: string;
  expectedRep: string | null;
  ambiguous: boolean;
  informational: boolean;
  ranked: { speaker: string; repLikelihood: number; reasons: string[] }[];
  top1: string;
  correct: boolean | null;
  gate: boolean;
  silentWrong: boolean;
  caught: boolean;
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const { excerpt, stats } = speakerEvidence(toWords(scenario.turns));
  const ranked = (await assessSpeakers(excerpt, stats)).sort((a, b) => b.repLikelihood - a.repLikelihood);
  const top1 = ranked[0]?.speaker ?? "none";
  const correct = scenario.expectedRep === null ? null : top1 === scenario.expectedRep;
  const gate = needsSpeakerConfirmation(ranked);
  return {
    id: scenario.id,
    notes: scenario.notes,
    expectedRep: scenario.expectedRep,
    ambiguous: !!scenario.ambiguous,
    informational: !!scenario.informational,
    ranked,
    top1,
    correct,
    gate,
    silentWrong: correct === false && !gate,
    caught: correct === false && gate,
  };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!);
    }
  }));
  return results;
}

const scenarios = [...baseScenarios, ...swappedScenarios, ...adversarial];
console.log(`Evaluating ${scenarios.length} scenarios against ${config.glm.model}...`);
const rows = await mapConcurrent(scenarios, 3, async (scenario) => {
  try {
    const row = await runScenario(scenario);
    console.log(`${row.correct === false ? "MISS" : row.correct ? "ok  " : "n/a "} ${row.id} top=${row.top1} gate=${row.gate}`);
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERR  ${scenario.id}: ${message}`);
    return { id: scenario.id, notes: scenario.notes, expectedRep: scenario.expectedRep, ambiguous: !!scenario.ambiguous, informational: !!scenario.informational, ranked: [], top1: "error", correct: false, gate: false, silentWrong: false, caught: false, error: message } as Row & { error: string };
  }
});

const scored = rows.filter((row) => row.expectedRep !== null && !row.informational);
const accuracy = (list: Row[]) => list.filter((row) => row.correct).length / Math.max(1, list.length);
const base = rows.filter((row) => row.id.startsWith("base-"));
const swapped = rows.filter((row) => row.id.startsWith("swapped-"));
const adversarialScored = rows.filter((row) => row.id.startsWith("adv-") && row.expectedRep !== null && !row.informational);
const customerFirstMultiSpeaker = rows.filter((row) => row.id.startsWith("adv-customer-first-"));
const summary = {
  generatedAt: new Date().toISOString(),
  model: config.glm.model,
  thresholds: SPEAKER_CONFIRMATION,
  counts: {
    scenarios: scenarios.length,
    scored: scored.length,
    silentWrong: rows.filter((row) => row.silentWrong).length,
    caughtByGate: rows.filter((row) => row.caught).length,
    gateFired: rows.filter((row) => row.gate).length,
    errors: rows.filter((row) => row.top1 === "error").length,
  },
  accuracy: {
    base: accuracy(base),
    swapped: accuracy(swapped),
    adversarial: accuracy(adversarialScored),
    customerFirstMultiSpeaker: accuracy(customerFirstMultiSpeaker),
    overall: accuracy(scored),
  },
  ambiguousGateCheck: rows.filter((row) => row.ambiguous).map((row) => ({ id: row.id, gate: row.gate, ranked: row.ranked })),
  informational: rows.filter((row) => row.informational).map((row) => ({ id: row.id, correct: row.correct, gate: row.gate, ranked: row.ranked })),
  rows,
};

const outDir = path.resolve(process.env.EVAL_RESULT_DIR ?? "eval-results");
await mkdir(outDir, { recursive: true });
// A provider outage must not replace the last complete evaluation with errors.
const hasErrors = rows.some((row) => row.top1 === "error");
const outFile = path.join(outDir, hasErrors ? "rep-speaker-evaluation.failed.json" : "rep-speaker-evaluation.json");
await writeFile(outFile, JSON.stringify(summary, null, 2));

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
console.log("\n=== Summary ===");
console.log(`Base (labeled, rep=speaker_0):   ${pct(summary.accuracy.base)} (${base.filter((r) => r.correct).length}/${base.length})`);
console.log(`Swapped (rep=speaker_1):         ${pct(summary.accuracy.swapped)} (${swapped.filter((r) => r.correct).length}/${swapped.length})`);
console.log(`Adversarial:                     ${pct(summary.accuracy.adversarial)} (${adversarialScored.filter((r) => r.correct).length}/${adversarialScored.length})`);
console.log(`Customer-first, 3+ speakers:     ${pct(summary.accuracy.customerFirstMultiSpeaker)} (${customerFirstMultiSpeaker.filter((r) => r.correct).length}/${customerFirstMultiSpeaker.length})`);
console.log(`Overall top-1:                   ${pct(summary.accuracy.overall)} (${scored.filter((r) => r.correct).length}/${scored.length})`);
console.log(`Gate fired:                      ${summary.counts.gateFired}/${scenarios.length}`);
console.log(`Confidently wrong (dangerous):   ${summary.counts.silentWrong}`);
console.log(`Wrong but caught by gate:        ${summary.counts.caughtByGate}`);
console.log(`Ambiguous scenario gate check:   ${JSON.stringify(summary.ambiguousGateCheck.map((r) => ({ id: r.id, gate: r.gate })))}`);
console.log(`\nWrote ${outFile}`);
