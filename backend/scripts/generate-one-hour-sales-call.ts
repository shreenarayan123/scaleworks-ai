import "dotenv/config";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required.");
const modelId = process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_v3";
const outputDir = path.resolve(process.env.SALES_SAMPLE_DIR ?? "eval-results/sales-samples");
const id = "one-hour-apologetic-interrupting-sales-call";
const repVoice = "EXAVITQu4vr4xnSDxMaL"; // Sarah: mature, reassuring, confident
const customerVoice = "CwhRBWXzGAHq8TQ4Fs17"; // Roger: conversational American male

type Topic = { title: string; customer: string; details: string[]; desired: string };
const topics: Topic[] = [
  { title: "opening and account history", customer: "I want to start with the account history because the last few months have been confusing", details: ["the original quote described a fixed monthly rate, while the invoices now show a platform fee and separate usage charges", "I have called twice already and each time I had to explain the same history from the beginning", "our account changed hands between two representatives, so the notes I was promised never appeared in the follow-up", "the first invoice looked correct and then the next three had amounts that nobody could explain clearly", "I am not trying to make this personal; I need one accurate version of what we agreed to", "my finance lead has asked me to pause any expansion until we understand the current arrangement"], desired: "a single written account summary with dates, agreed terms, and the name of one person who owns the follow-up" },
  { title: "unexpected charges", customer: "The first concrete issue is the amount we have been charged", details: ["the invoice is higher than the proposal by an amount that is material for a small team", "a usage line appeared even though we were told our projected volume sat inside the included allowance", "the service fee moved between invoices without anyone telling us when the change would take effect", "the credit discussed on the previous call is still missing from the latest statement", "we see two separate charges that appear to describe the same group of seats", "our accounts payable team cannot approve the invoice while the supporting calculation is unclear"], desired: "an itemized reconciliation, a corrected invoice where needed, and a clear date for any credit" },
  { title: "sales promises and scope", customer: "The second issue is the gap between what we expected and what we received", details: ["the demo showed a connection to our existing system that is not available in our current package", "we were told setup would be handled with us, but the onboarding email linked to a self-service guide", "the proposal mentioned reporting across every location, while our account only shows one location", "I was led to believe our old workflow could remain in place during the transition", "the call notes described two training sessions, but the booking link only offered a paid workshop", "we made the decision based on the outcomes shown in the demonstration, not just the feature list"], desired: "a plain-language comparison of the original scope, the current package, and the path to close any gap" },
  { title: "integration and technical fit", customer: "Before we can make any decision, I need to explain the integration problem", details: ["our administrator found that the connector requires a permission our security team does not grant by default", "the field mapping in the guide does not match the labels our team actually uses", "a test record duplicated instead of updating, so we stopped the test before it touched live data", "the integration guide appears to describe a different version of the product than our workspace", "we need to preserve the audit trail and cannot accept a setup that overwrites the owner field", "our technical lead has only a short window this week and needs answers before booking it"], desired: "a technical review with our administrator, documented prerequisites, and a safe test plan" },
  { title: "rollout risk", customer: "I also need to talk through the risk of changing the process while we are busy", details: ["we are entering our busiest month and cannot have the team lose access during a migration", "several people rely on the current reports for daily decisions, even if the process is not ideal", "we have no spare staff to repeat work if the records fail to transfer cleanly", "our regional managers need to see the same numbers during the transition", "we need to know who can stop the rollout if something unexpected happens", "a previous vendor said the migration was simple and it still caused days of disruption"], desired: "a phased rollout schedule with owners, checkpoints, rollback steps, and a contact for urgent issues" },
  { title: "training and adoption", customer: "Training is another part that has not been clear to the people who will use this", details: ["the new users received login links but no explanation of what they should do on the first day", "our supervisors have different levels of comfort with software and need more than a recorded tour", "the person who attended the original demo is not the same person who will manage the workflow", "we need examples from our own process instead of a generic sample account", "some staff work in short shifts and cannot all join one long session", "we want to avoid presenting this as another system that creates extra admin work"], desired: "a practical training plan with short sessions, role-specific examples, and a way to ask follow-up questions" },
  { title: "support and ownership", customer: "I need to understand what support looks like after the sale", details: ["the help page sends us between billing and technical support without anyone taking ownership", "we received an automated response but no answer to the specific question in the ticket", "the response time in the contract is not the response time we have experienced", "we do not know whether our account includes a named contact or a shared queue", "the ticket was marked solved even though the problem was still happening", "we cannot keep spending meeting time repeating context to a new person each time"], desired: "a named owner, a clear escalation path, and realistic response times in writing" },
  { title: "security and approvals", customer: "There is an internal review we have to complete before we can move ahead", details: ["our security reviewer needs to know where data is stored and who can access it", "procurement needs the current terms and a complete list of optional fees", "our legal team has a question about notice periods and what happens to exported data", "the approval form asks for an implementation date that we cannot confirm yet", "our risk committee meets only once a month, so missing this cycle adds real delay", "we were not given a security packet when we first asked for one"], desired: "the current security documents, contract terms, and a checklist our reviewers can use" },
  { title: "renewal and pricing", customer: "The renewal timing makes all of these questions more urgent", details: ["the renewal date is close, but we still have open questions about the plan we are renewing", "the proposed increase was not explained in the notice our finance team received", "we need to compare the current plan with the next tier without being pushed into a same-day decision", "the quote expires before our budget owner is back from leave", "we want to understand whether unused seats can be removed before the renewal begins", "our team does not want to sign an extension that locks in unresolved issues"], desired: "a written quote with options, an explanation of each price change, and enough time to review it" },
  { title: "reporting and outcomes", customer: "The reports matter because we need to show whether the service is helping", details: ["the dashboard total differs from the export we sent to our leadership team", "we cannot separate activity by location in the report we currently have", "the baseline from before launch was never documented, so the comparison is difficult", "some events show up a day later and people think the report is incomplete", "we need to know which numbers are measured and which are estimates", "our director wants to see a useful result, not a chart that only looks impressive"], desired: "a validated report, definitions for the key metrics, and a baseline review with our team" },
  { title: "decision process", customer: "I should explain how decisions are made on our side", details: ["I can describe the workflow but I cannot approve the contract on my own", "our operations lead and finance owner need to agree before we can change the plan", "the people who will use the tool have not had a chance to ask questions yet", "we need the technical reviewer to confirm the integration before procurement starts", "we do not make a decision because of an expiring discount or a call deadline", "I would rather be candid about the steps now than promise something I cannot deliver"], desired: "a realistic sequence of reviews and a follow-up date that leaves the decision with our team" },
  { title: "closing and commitments", customer: "Before we finish, I want to check that we have captured the commitments correctly", details: ["I want the invoice review and the integration review treated as separate work items", "the follow-up should include the actual documents rather than a note saying they are coming", "please do not mark this resolved until we confirm the important questions are answered", "I need one contact who can see the history and coordinate the next steps", "we can consider the proposal after we see the corrected details and review them internally", "I want to leave this call with dates, owners, and a way to raise anything that slips"], desired: "a recap with named owners, specific due dates, and no pressure to decide before the review is complete" },
];

const customerOpeners = [
  "Please let me finish the whole point before you respond, because the order of events matters here.",
  "I have notes in front of me, so I am going to walk through them carefully and then hear your response.",
  "I want to be precise rather than dramatic; this has affected our work, and I need us to deal with the facts.",
  "I am going to explain what happened from our side, including what we tried and where the information stopped lining up.",
  "I have already spent time gathering the details, and I would appreciate being able to give you the complete picture.",
  "Let me get through this part first, because the answer changes depending on what happened before the latest call.",
];
const customerClosers = [
  "I am willing to work through it with you, but I need to know that the next step will be concrete and recorded.",
  "I am not asking for a special favor; I am asking for the service and explanation we understood we were buying.",
  "That is why I am still on the phone instead of simply walking away, but I need a plan I can stand behind internally.",
  "I want to be fair to your team too, so please tell me what you can actually commit to and what needs another owner.",
  "We can keep talking about options after the open questions are answered, but I cannot skip over them to get there.",
  "I am happy to review a proposal when it reflects the real requirements and gives our team time to consider it.",
];
const repInterruptions = [
  "[interrupting, apologetic] I am sorry to cut in; I can hear you are still laying out the timeline, and I should let you finish. I jumped to an explanation before I understood the details, which is exactly what has made this frustrating. Please continue, and I will take notes before I respond.",
  "[interrupting, apologetic] I apologize for talking over you. I thought I recognized the issue and started trying to fix it before you had finished describing what happened. That was premature, and I can see why it feels like I am not listening. Go ahead; I will hold my response until you have finished the point.",
  "[interrupting, apologetic] Sorry, I am interrupting again, and that is on me. I want to acknowledge the impact, but I should not make you fight for the space to explain it. I have the key concern written down now. Please finish what you were saying, and then I will answer the question you actually asked.",
  "[interrupting, apologetic] I am sorry. I cut across you because I was eager to reassure you, and reassurance without the facts is not useful. I will slow down and let you complete the example. After that I can check the account, tell you what I know, and be clear about what I still need to verify.",
  "[interrupting, apologetic] Please accept my apology for jumping in. I hear how important the sequence is, and I have not earned the right to shortcut it. Keep going; I am listening. When you are done, I will repeat back the issue in my own words so you can correct anything I have misunderstood.",
  "[interrupting, apologetic] Sorry for stepping on your sentence. I know you are explaining a real consequence for your team, not just a preference. I am going to stop and listen through the full example. Then we can separate what I can resolve today from the parts that need another specialist.",
];
const repFollowups = [
  "Thank you for finishing that explanation. I should have asked before assuming I knew the answer. I am sorry for the interruption and for the extra work this has caused. The detail I am taking away is that the issue is not isolated; it connects to the expectations we set and to the way your team has had to operate since then.",
  "I appreciate you correcting me. I am sorry that my earlier response made it sound as though the burden was on you to keep repeating yourself. I will take responsibility for coordinating this from our side. Let me confirm the specific detail, document it in the case, and avoid promising a fix until the person responsible has checked it.",
  "You are right to ask for a clear answer. I am sorry I moved too quickly into the sales conversation instead of resolving the open concern first. I will not ask you to make a commitment while the facts are still unsettled. I can set out the options and the review steps, and you can decide after your team has had time to look at them.",
  "I hear you, and I am sorry. I interrupted because I was trying to manage the call instead of listening to your experience. I am going to make this practical now: I will record the concern, identify the owner, and send you a written update with a date. If I cannot confirm something today, I will say so plainly rather than leave you guessing.",
  "Thank you for being direct about that. I apologize for the way I spoke over you. I understand that trust comes from follow-through, not from me saying the right words on this call. I will capture exactly what you want reviewed, confirm who is taking it, and make sure the next contact starts with the history you have already provided.",
  "I am sorry, and I will give you the floor. I understand the impact is not only the charge or the setup; it is the time spent chasing an answer and the uncertainty that creates for your colleagues. I have noted that context. Please tell me if there is another important detail I should include before I outline the next steps.",
];
const customerResponses = [
  "That is closer to what I need. The important thing is that the notes carry forward, because I do not want to spend another call starting at the beginning. Please include the detail I just gave you, not only a broad summary that loses why it matters.",
  "I appreciate the apology, but I need to be honest that we have heard a few apologies already. What would rebuild confidence is a response with an owner and a date, plus an explanation if something turns out to be different from what we expected.",
  "Yes, please write that down. I am not trying to make the call difficult. I am trying to get the same answer from everyone involved, so my team does not act on one explanation and then discover another interpretation later.",
  "I can work with that process if it is realistic. Please do not mark the issue as fixed just because a ticket was assigned or a document was sent. We will confirm when we have reviewed the information and can see whether it answers the question.",
  "That makes sense as a next step. I still need to share the outcome with the people who own the budget and the workflow. If you send the details in a usable format, I can bring them to the right people without paraphrasing this whole conversation.",
  "I hear what you are saying. I would like to keep the conversation constructive, but I also need room to explain the impact before we start discussing another purchase or a renewal. We can return to that after the open issue has a credible path to resolution.",
];
const repPlans = [
  "For this item, I will open a follow-up with the details you gave me, assign it to the team that can verify the underlying record, and send you the case reference. I will include the owner and the expected update date so you are not left to chase a general inbox. I am sorry again for interrupting; I will stay with your explanation now.",
  "I can take the coordination role. I will send a written recap today, request the relevant review, and keep the sales discussion separate until we have an answer. If the review needs more time, I will tell you before the date passes and explain what is pending. I am sorry I cut you off while you were trying to give me the context.",
  "Here is the plan I can responsibly offer: I will document the concern, confirm the right owner, and return with the evidence or the specific question we still need to resolve. I will not tell you the issue is settled until you have had a chance to review the response. Thank you for your patience, and I apologize for interrupting you.",
  "I will put the next step and the expected timing in writing, then make sure the specialist sees this full history rather than a one-line handoff. If anything in my recap is inaccurate, you can correct it before we move forward. I am sorry for speaking over you; I will pause here and let you add anything I missed.",
  "I want to make the follow-through easy to check. I will send one message with the owner, the due date, and the documents or decisions still outstanding. You can reply to that thread if anything changes, and I will coordinate the response. I apologize for the interruptions today. You should not have had to work this hard to be heard.",
  "I understand you are not agreeing to buy anything on this call, and I will respect that. My immediate responsibility is to get the current questions answered. After that, if you want, I can provide a clear option for the next term with the costs and assumptions stated. I am sorry again for cutting in; please finish your thought.",
];

function buildTranscript() {
  const turns: { speaker: "customer" | "rep"; text: string }[] = [];
  for (const [topicIndex, topic] of topics.entries()) {
    for (let round = 0; round < 2; round++) {
      const detail = topic.details[round]!;
      const v = (round + topicIndex) % 6;
      const first = topicIndex === 0 && round === 0;
      const customer = first
        ? `Hello, thanks for taking my call. I want to start with the account history because the last few months have been confusing. ${customerOpeners[v]} ${detail}. I have made a short timeline so we can get through it accurately. ${customerClosers[v]}`
        : `${topic.customer}. ${customerOpeners[v]} ${detail}. ${customerClosers[v]}`;
      turns.push({ speaker: "customer", text: customer });
      turns.push({ speaker: "rep", text: `${repInterruptions[v]} ${repFollowups[(v + 2) % 6]} In particular, I have noted: ${detail}. I am sorry I interrupted you. I will make sure the follow-up addresses this point, including the part about ${topic.desired}.` });
      turns.push({ speaker: "customer", text: `${customerResponses[(v + 1) % 6]} To be specific about ${topic.title}, ${detail}. The outcome I need is ${topic.desired}. I want to make sure there is no misunderstanding about that before we move to another topic.` });
      turns.push({ speaker: "rep", text: `${repPlans[(v + 3) % 6]} I am sorry for interrupting earlier. Before I take the next step, let me repeat the request: for ${topic.title}, you need ${topic.desired}. Is that a fair summary, or is there a detail you want to change?` });
    }
  }
  return turns;
}

function chunksOf(turns: ReturnType<typeof buildTranscript>) {
  const chunks: typeof turns[] = [];
  let chunk: typeof turns = [];
  let chars = 0;
  for (const turn of turns) {
    if (chunk.length && chars + turn.text.length > 1_700) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(turn);
    chars += turn.text.length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const chunkDir = path.join(outputDir, `${id}-parts`);
  await mkdir(chunkDir, { recursive: true });
  const turns = buildTranscript();
  const chunks = chunksOf(turns);
  const prior = new Set(await readdir(chunkDir));
  if (process.env.ASSEMBLE_ONLY !== "1") for (let start = 0; start < chunks.length; start += 2) {
    const batch = chunks.slice(start, start + 2);
    await Promise.all(batch.map(async (_, offset) => {
      const i = start + offset;
      const partName = `${String(i + 1).padStart(3, "0")}.mp3`;
      if (prior.has(partName)) return;
      const inputs = chunks[i]!.map(({ speaker, text }) => ({
        text,
        voice_id: speaker === "rep" ? repVoice : customerVoice,
      }));
      const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue", {
        method: "POST",
        headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
        body: JSON.stringify({ model_id: modelId, inputs, output_format: "mp3_44100_128" }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`ElevenLabs failed on part ${i + 1}/${chunks.length}: ${response.status} ${(await response.text()).slice(0, 400)}`);
      await writeFile(path.join(chunkDir, partName), Buffer.from(await response.arrayBuffer()));
      console.log(`generated part ${i + 1}/${chunks.length}`);
    }));
  }

  const partNames = [...prior].filter((name) => /^\d{3}\.mp3$/.test(name)).sort();
  const completedCount = partNames.length;
  if (completedCount === 0) throw new Error("No generated parts are available to assemble.");
  const completedTurns = chunks.slice(0, completedCount).flat();
  const completedChunks = chunks.slice(0, completedCount);
  const closingText = "[apologetic] I am sorry for interrupting you and rushing the conversation. I have your decision process noted, and I will send the written recap with an owner and date today. Thank you.";
  const hasClosing = prior.has("closing.mp3");
  const transcript = completedTurns.map(({ speaker, text }) => `${speaker === "customer" ? "Customer" : "Salesperson"}: ${text}`).join("\n\n")
    + (hasClosing ? `\n\nSalesperson: ${closingText}` : "");
  await writeFile(path.join(outputDir, `${id}.txt`), transcript, "utf8");
  const concatList = path.join(chunkDir, "concat.txt");
  const concatParts = completedChunks.map((_, i) => `file '${String(i + 1).padStart(3, "0")}.mp3'`);
  if (hasClosing) concatParts.push("file 'closing.mp3'");
  await writeFile(concatList, concatParts.join("\n"));
  const rawMp3 = path.join(outputDir, `${id}-raw.mp3`);
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", rawMp3], { cwd: chunkDir });
  const mp3 = path.join(outputDir, `${id}.mp3`);
  const info = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", rawMp3]);
  const duration = Number(info.stdout.trim());
  const tempo = (duration / 3600).toFixed(5);
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", rawMp3, "-af", `atempo=${tempo},afade=t=out:st=3598:d=2`, "-t", "3600", "-c:a", "libmp3lame", "-b:a", "128k", mp3]);
  const finalInfo = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", mp3]);
  await writeFile(path.join(outputDir, `${id}.json`), JSON.stringify({
    id, label: "One-hour sales call: customer speaks first; apologetic salesperson repeatedly interrupts",
    modelId, voices: { salesperson: { name: "Sarah", id: repVoice }, customer: { name: "Roger", id: customerVoice } },
    transcript: `${id}.txt`, generatedChunkCount: completedCount, originalSpeechDurationSeconds: duration,
    finalAudio: JSON.parse(finalInfo.stdout.trim()),
    deliveryDirection: "Customer opens and remains firm but constructive. Salesperson repeatedly interrupts with apologies, acknowledges the interruption, listens, and gives concrete follow-up steps.",
  }, null, 2));
  console.log(`created ${mp3}; source dialogue duration ${duration.toFixed(2)} seconds; final file tempo-adjusted to 3600 seconds`);
}

await main();
