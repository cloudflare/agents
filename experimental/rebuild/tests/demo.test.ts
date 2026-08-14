/**
 * Demo-module tests — the deterministic strategies driven by the mock model.
 * (eliza is trivially covered via the therapist preset; the AI SDK adapter
 * has no local runtime by design.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentDefinition,
  Entry,
  MessagePayload,
  TurnInfo
} from "../src/contract";
import { startAgent } from "../src/runtime/host";
import { stepHarness } from "../src/harness/step-harness";
import { defaultLoop } from "../src/harness/default-loop";
import { defaultAdmission } from "../src/admission/default";
import { localChannel } from "../src/channels/local";
import { MockLanguageModel, mockText, mockToolCall } from "../src/models/mock";
import { createEngine } from "../src/engine/engine";
import { systemClock } from "../src/substrate";
import { asBranchId, asEntryId, asTurnId } from "../src/ids";
import { sqliteDb } from "./helpers";

import { therapist, debateClub } from "../src/demo/presets";
import { rollingWindow } from "../src/demo/context/window";
import { compactor } from "../src/demo/context/compactor";
import { librarian } from "../src/demo/context/librarian";
import { priorityLanes } from "../src/demo/admission/priority";
import { demoTools, evaluate } from "../src/demo/tools";
import { tollbooth } from "../src/demo/middleware/tollbooth";
import { planner } from "../src/demo/loops/planner";

const RETRY = { maxAttempts: 2, backoff: { initialMs: 5, factor: 2, maxMs: 10 } };

test("therapist preset: eliza answers through the whole stack", async () => {
  const channel = localChannel();
  const agent = startAgent(therapist([channel]), { db: sqliteDb() });
  await channel.send("I feel underappreciated by my compiler");
  await agent.waitUntilQuiescent();
  assert.deepEqual(channel.delivered, [
    "Tell me more about feeling underappreciated by my compiler."
  ]);
  await agent.stop();
});

test("planner loop: durable plan, tool step, notes, final answer", async () => {
  const db = sqliteDb();
  const channel = localChannel();
  const model = new MockLanguageModel([
    mockText("1. Compute the sum\n2. Report it"),
    mockToolCall("pl1", "demo/evaluate", { expression: "2+3" }),
    mockText("The sum came out to 5."),
    mockText("Reported the sum to the user."),
    mockText("2 + 3 = 5.")
  ]);
  const definition: AgentDefinition = {
    channels: [channel],
    admission: defaultAdmission(),
    tools: { providers: [demoTools()] },
    harness: stepHarness({
      loop: planner(),
      model,
      context: rollingWindow({ system: "strategist" }),
      policy: { maxSteps: 10, retry: RETRY }
    })
  };
  const agent = startAgent(definition, { db });
  await channel.send("what is 2+3?");
  await agent.waitUntilQuiescent();

  assert.deepEqual(channel.delivered, ["2 + 3 = 5."]);
  const view = agent.engine.view();
  const plans = await view.query({ kinds: ["planner/plan"], limit: 5 });
  assert.ok(plans.length >= 2); // initial plan + progress updates
  const latestPlan = plans[0].payload as unknown as { steps: string[]; done: number };
  assert.deepEqual(latestPlan.steps, ["Compute the sum", "Report it"]);
  assert.equal(latestPlan.done, 2);
  const notes = await view.query({ kinds: ["planner/note"], limit: 5 });
  assert.equal(notes.length, 2);
  // The tool call really went through the ledger.
  assert.equal((await view.query({ kinds: ["effect/claimed"], limit: 5 })).length, 0); // readonly → no claim
  await agent.stop();
});

test("debate club preset: three arguments on the log, then one answer", async () => {
  const db = sqliteDb();
  const channel = localChannel();
  const thinker = new MockLanguageModel([
    mockText("Answer immediately; the question is simple."),
    mockText("Simple questions deserve care too."),
    mockText("Care yes, but brevity wins here."),
    mockText("Briefly, with care: yes, please rebuild it.")
  ]);
  const curator = new MockLanguageModel(() => mockText("#1"));
  const agent = startAgent(debateClub(thinker, curator, [channel]), { db });

  await channel.send("please, should we rebuild the SDK?");
  await agent.waitUntilQuiescent();

  assert.deepEqual(channel.delivered, ["Briefly, with care: yes, please rebuild it."]);
  const args = await agent.engine.view().query({ kinds: ["debater/argument"], limit: 10 });
  assert.equal(args.length, 3);
  const personas = [...args].reverse().map((e) => (e.payload as unknown as { persona: string }).persona);
  assert.deepEqual(personas, ["The Advocate", "The Skeptic", "The Advocate"]);
  await agent.stop();
});

test("bouncer: no magic word, no turn — the entry stays un-acted-upon", async () => {
  const db = sqliteDb();
  const channel = localChannel();
  const thinker = new MockLanguageModel(() => mockText("admitted!"));
  const curator = new MockLanguageModel(() => mockText("#1"));
  const agent = startAgent(debateClub(thinker, curator, [channel]), { db });

  await channel.send("let me in");
  await agent.waitUntilQuiescent();
  assert.equal((await agent.engine.view().query({ kinds: ["turn/marker"], limit: 3 })).length, 0);
  assert.deepEqual(channel.delivered, []);

  await channel.send("let me in, please");
  await agent.waitUntilQuiescent();
  assert.deepEqual(channel.delivered, ["admitted!"]);
  await agent.stop();
});

test("tollbooth: priced dice park on a 402 until payment (approval) lands", async () => {
  const db = sqliteDb();
  const channel = localChannel();
  const model = new MockLanguageModel([
    mockToolCall("toll1", "demo/roll_dice", { sides: 20 }),
    mockText("You rolled well.")
  ]);
  const definition: AgentDefinition = {
    channels: [channel],
    admission: defaultAdmission(),
    tools: {
      providers: [demoTools({ random: () => 0.99 })],
      middleware: [tollbooth({ "demo/roll_dice": 2 })]
    },
    harness: stepHarness({
      loop: defaultLoop(),
      model,
      context: rollingWindow({}),
      policy: { maxSteps: 6, retry: RETRY }
    })
  };
  const agent = startAgent(definition, { db });
  await channel.send("roll me a d20");
  await agent.waitUntilQuiescent();

  const requests = await agent.engine.view().query({ kinds: ["tools/approval-requested"], limit: 3 });
  assert.equal(requests.length, 1);
  const descriptor = (requests[0].payload as unknown as { descriptor: { title: string } }).descriptor;
  assert.match(descriptor.title, /402 Payment Required/);
  assert.match(descriptor.title, /2 credits/);

  await agent.approve("toll1", "granted");
  await agent.waitUntilQuiescent();
  assert.deepEqual(channel.delivered, ["You rolled well."]);
  // The paid effect settled through the ledger exactly once.
  assert.equal((await agent.engine.view().query({ kinds: ["effect/settled"], limit: 5 })).length, 1);
  await agent.stop();
});

test("compactor: aged history becomes a private summary entry the engine never understands", async () => {
  const db = sqliteDb();
  const channel = localChannel();
  const thinker = new MockLanguageModel(() => mockText("Noted."));
  const summarizer = new MockLanguageModel(() => mockText("They exchanged twenty pleasantries."));
  const memory = compactor({ system: "base", summarizer, keepRecent: 4, highWater: 10 });
  const definition: AgentDefinition = {
    channels: [channel],
    admission: defaultAdmission(),
    tools: { providers: [] },
    harness: stepHarness({
      loop: memory.withCompaction(defaultLoop()),
      model: thinker,
      context: memory.assembler,
      policy: { maxSteps: 3, retry: RETRY }
    })
  };
  // Twenty pleasantries of history, seeded before the host wakes — this is
  // "an old conversation on disk", not live traffic through admission.
  const { engine: seeder } = createEngine(db, systemClock());
  const seed = Array.from({ length: 20 }, (_, i) => ({
    origin: { module: "test" },
    payload: {
      kind: "message",
      v: 1,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `pleasantry ${i}` }]
    } satisfies MessagePayload
  }));
  await seeder.append(seed as never);

  const agent = startAgent(definition, { db });
  await channel.send("so, where were we?");
  await agent.waitUntilQuiescent();

  const summaries = await agent.engine.view().query({ kinds: ["compactor/summary"], limit: 3 });
  assert.equal(summaries.length, 1);
  assert.match((summaries[0].payload as unknown as { summary: string }).summary, /twenty pleasantries/);
  // The thinking model saw the summary in its system prompt, not 20 messages.
  const request = thinker.requests[0];
  assert.match(request.system ?? "", /summarized/);
  assert.ok(request.messages.length <= 5, `saw ${request.messages.length} messages`);
  await agent.stop();
});

test("librarian: a second model curates which entries the first one sees", async () => {
  const db = sqliteDb();
  const { engine } = createEngine(db, systemClock());
  for (let i = 0; i < 6; i++) {
    await engine.append([
      {
        origin: { module: "test" },
        payload: {
          kind: "message",
          v: 1,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [{ type: "text", text: `message number ${i + 1}` }]
        } satisfies MessagePayload
      } as never
    ]);
  }
  const curator = new MockLanguageModel(() => mockText("the relevant entries are #2 and #4"));
  const assembler = librarian({ system: "curated", librarian: curator, shortlist: 10, pick: 3 });

  const request = await assembler.assemble({
    view: engine.view(),
    turn: fakeTurn(),
    tools: [],
    budget: {}
  });
  // Picked #2 and #4, plus the newest message (always kept): three total.
  assert.equal(request.messages.length, 3);
  const texts = request.messages.map((m) => (m.parts[0] as { text: string }).text);
  assert.deepEqual(texts, ["message number 2", "message number 4", "message number 6"]);
  // The curator was shown a catalog, not the raw conversation.
  assert.match(textOfFirstUserPart(curator.requests[0].messages as never), /#1 \[user\]/);
});

test("priorityLanes: source-aware decisions, as pure function calls", () => {
  const policy = priorityLanes({ preempt: ["pager"] });
  const active: TurnInfo = { ...fakeTurn(), status: "active" };
  const parked: TurnInfo = { ...fakeTurn(), status: "parked" };

  assert.equal(policy.decide({ entry: msg("user", "pager"), active, queued: [] }).action, "preempt");
  assert.equal(policy.decide({ entry: msg("user", "web"), active, queued: [] }).action, "queue");
  assert.equal(policy.decide({ entry: msg("user", "web"), queued: [] }).action, "start");
  assert.equal(
    policy.decide({
      entry: settled(parked.turnId),
      active: parked,
      queued: []
    }).action,
    "resume"
  );
});

// ---------------------------------------------------------------------------

function fakeTurn(): TurnInfo {
  return {
    turnId: asTurnId("t-1"),
    branch: asBranchId("main"),
    trigger: { branch: asBranchId("main"), seq: 1, id: asEntryId("e-1") },
    status: "active",
    attempt: 1,
    startedAt: 0
  };
}

function msg(role: "user" | "assistant", instance: string): Entry {
  return {
    ref: { branch: asBranchId("main"), seq: 9, id: asEntryId("e-9") },
    at: 0,
    origin: { module: "channel", instance },
    payload: { kind: "message", v: 1, role, parts: [{ type: "text", text: "hi" }] }
  } as Entry;
}

function settled(turn: TurnInfo["turnId"]): Entry {
  return {
    ref: { branch: asBranchId("main"), seq: 10, id: asEntryId("e-10") },
    at: 0,
    origin: { module: "ledger" },
    turn,
    payload: { kind: "effect/settled", v: 1, key: "k", result: { status: "ok", output: 1 } }
  } as unknown as Entry;
}

function textOfFirstUserPart(messages: readonly { parts: readonly { type: string; text?: string }[] }[]): string {
  const part = messages[0]?.parts[0];
  return part !== undefined && part.type === "text" ? (part.text ?? "") : "";
}

test("evaluate: the readonly tool's arithmetic parser", () => {
  assert.equal(evaluate("2+3*4"), 14);
  assert.equal(evaluate("(2+3)*4"), 20);
  assert.equal(evaluate("-3 + 10 / 2"), 2);
  assert.throws(() => evaluate("2 + banana"));
});
