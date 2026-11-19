// Quick check of the real external APIs without the database:
//   npx tsx scripts/try-external.ts ../voice.wav
import { transcribe } from "../src/scribe.js";
import { buildRepSegments, sentences, textOf } from "../src/segments.js";
import { wavDurationSec } from "../src/wav.js";
import { extractActionItems, judgeTone } from "../src/llm.js";

const file = process.argv[2] ?? "../voice.wav";
const duration = await wavDurationSec(file);
console.log("duration", duration.toFixed(2));
const t = await transcribe(file, "sample.wav", duration);
console.log("words", t.words.length, "speakers", [...new Set(t.words.map((w) => w.speaker))]);
const turns = sentences(t.words).map((s) => ({ speaker: s.speaker, start: s.start, end: s.end, text: textOf(s.words) }));
for (const turn of turns) console.log(`  [${turn.start.toFixed(1)}-${turn.end.toFixed(1)}] ${turn.speaker}: ${turn.text}`);
const rep = t.words[0]!.speaker;
console.log("rep segments", buildRepSegments(t.words, rep, duration).map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`));
const lines = turns.map((x) => ({ role: x.speaker === rep ? "REP" as const : "CUSTOMER" as const, start: x.start, text: x.text }));
console.log("actionItems", JSON.stringify(await extractActionItems(lines), null, 1));
console.log("verdict", JSON.stringify(await judgeTone(lines.filter((l) => l.role === "REP"), [], {}, []), null, 1));
