/**
 * Durability: kill the host mid-turn, start a new host over the same
 * database, and the turn completes with no duplicated side effects. This is
 * the log-is-the-snapshot claim under test — no fiber snapshots, no recovery
 * classification, just rehydration from committed state plus the ledger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { startAgent } from "../src/runtime/host.js";
import {
  MockLanguageModel,
  mockText,
  mockToolCall
} from "../src/models/mock.js";
import { sqliteDb, testAgent, testProviders } from "./helpers.js";
import type { MessagePayload, TurnMarkerPayload } from "../src/contract.js";

test("crash after the tool step, before the answer: resumes, no double effect", async () => {
  const db = sqliteDb();
  const { provider, effects } = testProviders();

  // Host 1's model executes the mutating tool then BLOCKS forever on the
  // second generate — the abort mid-generate is the crash point.
  const blocked: { resolve: (() => void) | null } = { resolve: null };
  const blockingModel = new MockLanguageModel((req, call) => {
    if (call === 0) return mockToolCall("d1", "test/notify", { msg: "hi" });
    throw new Error("should not reach: test aborts before second generate");
  });
  const originalGenerate = blockingModel.generate.bind(blockingModel);
  blockingModel.generate = async (req, io) => {
    if (blockingModel.requests.length >= 1) {
      // Second call: hang until aborted (simulates in-flight inference).
      await new Promise<void>((resolve) => {
        blocked.resolve = resolve;
      });
      throw new Error("aborted");
    }
    return originalGenerate(req, io);
  };

  const agents1 = testAgent({ model: blockingModel, providers: [provider] });
  const host1 = startAgent(agents1.definition, { db });
  await agents1.channel.send("notify then answer");

  // Wait until the tool effect has happened and host 1 is hanging in step 2.
  await waitFor(() => effects.length === 1);
  await waitFor(() => blockingModel.requests.length === 1);
  await new Promise((r) => setTimeout(r, 50));

  // CRASH host 1.
  await host1.stop({ abort: true });
  blocked.resolve?.();

  // The log at crash time: user msg, assistant tool-call, tool result,
  // step-committed marker — no completion.
  const markersAtCrash = await hostView(db, provider).query();
  assert.ok(
    !markersAtCrash.includes("completed"),
    `no completion yet, got: ${markersAtCrash.join(",")}`
  );

  // Host 2 wakes over the same database with a working model.
  const model2 = new MockLanguageModel([mockText("Done: notified.")]);
  const agents2 = testAgent({ model: model2, providers: [provider] });
  const host2 = startAgent(agents2.definition, { db });
  await host2.waitUntilQuiescent();

  // The turn completed on host 2...
  const markers = await hostView(db, provider).query();
  assert.ok(markers.includes("completed"), markers.join(","));
  // ...the side effect ran EXACTLY once across both hosts...
  assert.deepEqual(effects, ['notify:{"msg":"hi"}']);
  // ...and host 2's model saw the tool result from host 1's work.
  const req = model2.requests[0];
  const resultParts = req.messages.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool-result")
  );
  assert.equal(resultParts.length, 1);
  // Delivery happened despite the crash (outbox replays from its cursor).
  assert.deepEqual(agents2.channel.delivered, ["Done: notified."]);

  await host2.stop();
});

test("crash after the final answer, before the marker: no regeneration", async () => {
  const db = sqliteDb();
  const { provider } = testProviders();

  // Directly seed the log as if host 1 died right after committing the final
  // assistant message but before the completed marker.
  const model1 = new MockLanguageModel([mockText("The answer is 4.")]);
  const agents1 = testAgent({ model: model1, providers: [provider] });
  const host1 = startAgent(agents1.definition, { db });
  await agents1.channel.send("2+2?");
  await host1.waitUntilQuiescent();

  // Snip the terminal markers to simulate the crash window, and reset the
  // turn to active as the wake scan would find it.
  db.exec("DELETE FROM rb_entries WHERE kind = 'turn/marker'");
  db.exec("UPDATE rb_turns SET status = 'active'");
  await host1.stop();

  const model2 = new MockLanguageModel(() => {
    throw new Error("model must not be called: answer already on the log");
  });
  const agents2 = testAgent({ model: model2, providers: [provider] });
  const host2 = startAgent(agents2.definition, { db });
  await host2.waitUntilQuiescent();

  const markers = await host2.engine
    .view()
    .query({ kinds: ["turn/marker"], limit: 5 });
  assert.equal((markers[0].payload as TurnMarkerPayload).marker, "completed");
  // Exactly one assistant answer on the log — not regenerated.
  const messages = await host2.engine
    .view()
    .query({ kinds: ["message"], limit: 10 });
  const assistants = messages.filter(
    (m) => (m.payload as MessagePayload).role === "assistant"
  );
  assert.equal(assistants.length, 1);

  await host2.stop();
});

// ---------------------------------------------------------------------------

function hostView(db: ReturnType<typeof sqliteDb>, _p: unknown) {
  return {
    async query(): Promise<string[]> {
      return db
        .exec(
          "SELECT payload_json FROM rb_entries WHERE kind = 'turn/marker' ORDER BY seq ASC"
        )
        .map(
          (r) =>
            (JSON.parse(r.payload_json as string) as TurnMarkerPayload).marker
        );
    }
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
