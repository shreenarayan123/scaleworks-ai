import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAnalysisSettings } from "./analysis-settings.js";
import { aggregateToneFindings, type ToneFinding } from "./llm.js";

const evalDir = fileURLToPath(new URL("../eval-results/", import.meta.url));

test("legacy saved rule objects convert to condition strings", () => {
  const settings = parseAnalysisSettings({ toneRules: [{ id: "old", text: "the rep pressures the customer", kind: "forbid", severity: "hard" }] });
  assert.deepEqual(settings.toneRules, ["the rep pressures the customer"]);
});

test("15 clip evaluation verdicts remain stable after rule schema simplification", async () => {
  const [manifestText, evaluationText] = await Promise.all([
    readFile(`${evalDir}clips/manifest.json`, "utf8"),
    readFile(`${evalDir}evaluation.json`, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as { clips: { id: string; inputs: { text: string }[] }[] };
  const evaluation = JSON.parse(evaluationText) as { rows: { id: string; run: number; stage: string; verdict: { verdict: "RED" | "GREEN"; flags: { timestamp: number; source: "text" | "voice"; quote: string; reason: string }[] } }[] };
  assert.equal(manifest.clips.length, 15);
  const clips = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const completedRows = evaluation.rows.filter((row) => row.stage === "done");
  assert.equal(completedRows.length, 75);
  for (const row of completedRows) {
    const clip = clips.get(row.id);
    assert.ok(clip, `missing eval clip ${row.id}`);
    const findings: ToneFinding[] = row.verdict.flags.map((flag, i) => ({
      ruleId: `builtin:regression-${i}`, triggered: true, quote: flag.quote,
      startMs: flag.timestamp * 1000, source: flag.source, confidence: 0.95, reason: flag.reason,
    }));
    // Historical eval artifacts store the grounded excerpt but not the exact Scribe transcript;
    // use the saved quotes as the evidence text so this isolates verdict behavior from grounding.
    const evidenceText = findings.map((finding) => finding.quote ?? "").join(" ");
    assert.equal(aggregateToneFindings(findings, evidenceText).verdict, row.verdict.verdict, `${row.id} run ${row.run}`);
  }
});
