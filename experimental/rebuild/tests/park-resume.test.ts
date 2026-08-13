/**
 * Park/resume: the eviction-safe replacement for durable-pause, detached
 * runs and auto-continuation. A parked turn holds NO in-memory state — both
 * tests prove it by resuming on a DIFFERENT host than the one that parked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { startAgent } from "../src/runtime/host";
import { MockLanguageModel, mockText, mockToolCall } from "../src/models/mock";
import { sqliteDb, testAgent, testProviders } from "./helpers";
import type { MessagePayload, TurnMarkerPayload } from "../src/contract";

test("approval: park on request, resume on verdict — across hosts", async () => {
  const db = sqliteDb();
  const { provider, effects } = testProviders();
  const script = [
    mockToolCall("a1", "test/delete", { path: "/tmp/x" }),
    mockText("Deleted after approval.")
  ];

  const agents1 = testAgent({ model: new MockLanguageModel(script), providers: [provider] });
  const host1 = startAgent(agents1.definition, { db });
  await agents1.channel.send("please delete /tmp/x");
  await host1.waitUntilQuiescent();

  // Parked awaiting approval; nothing executed yet.
  const markers1 = await host1.engine.view().query({ kinds: ["turn/marker"], limit: 3 });
  assert.equal((markers1[0].payload as TurnMarkerPayload).marker, "parked");
  assert.deepEqual(effects, []);
  const requests = await host1.engine
    .view()
    .query({ kinds: ["tools/approval-requested"], limit: 3 });
  assert.equal(requests.length, 1);

  // Host 1 dies while parked. Host 2 wakes; nothing is in memory anywhere.
  await host1.stop();
  const agents2 = testAgent({ model: new MockLanguageModel(script), providers: [provider] });
  const host2 = startAgent(agents2.definition, { db });

  await host2.approve("a1", "granted");
  await host2.waitUntilQuiescent();

  assert.deepEqual(effects, ['delete:{"path":"/tmp/x"}']);
  const markers2 = await host2.engine.view().query({ kinds: ["turn/marker"], limit: 3 });
  assert.equal((markers2[0].payload as TurnMarkerPayload).marker, "completed");
  assert.deepEqual(agents2.channel.delivered, ["Deleted after approval."]);

  await host2.stop();
});

test("approval rejected: the model sees the rejection and answers", async () => {
  const db = sqliteDb();
  const { provider, effects } = testProviders();
  const model = new MockLanguageModel((req, call) => {
    if (call === 0) return mockToolCall("r1", "test/delete", { path: "/etc" });
    return mockText("Understood, not deleting.");
  });
  const { definition, channel } = testAgent({ model, providers: [provider] });
  const agent = startAgent(definition, { db });

  await channel.send("delete /etc");
  await agent.waitUntilQuiescent();
  await agent.approve("r1", "rejected");
  await agent.waitUntilQuiescent();

  assert.deepEqual(effects, []); // never executed
  assert.deepEqual(channel.delivered, ["Understood, not deleting."]);
  // The rejection reached the model as an error tool-result.
  const second = model.requests[1];
  const resultPart = second.messages
    .flatMap((m) => m.parts)
    .find((p) => p.type === "tool-result");
  assert.ok(resultPart !== undefined && resultPart.type === "tool-result");
  assert.equal(resultPart.isError, true);

  await agent.stop();
});

test("pending tool: park on launch, resume when the settlement lands", async () => {
  const db = sqliteDb();
  const { provider, pendingCalls } = testProviders();
  const model = new MockLanguageModel((req, call) => {
    if (call === 0) return mockToolCall("p1", "test/launch", { job: "big" });
    return mockText("Job finished: ok");
  });
  const { definition, channel } = testAgent({ model, providers: [provider] });
  const agent = startAgent(definition, { db });

  await channel.send("run the big job");
  await agent.waitUntilQuiescent();

  assert.deepEqual(pendingCalls, ["p1"]);
  const markers = await agent.engine.view().query({ kinds: ["turn/marker"], limit: 3 });
  assert.equal((markers[0].payload as TurnMarkerPayload).marker, "parked");

  // The provider's inbound half reports completion (correlated settlement).
  await agent.settleTool("p1", { result: "ok" });
  await agent.waitUntilQuiescent();

  const markersAfter = await agent.engine.view().query({ kinds: ["turn/marker"], limit: 3 });
  assert.equal((markersAfter[0].payload as TurnMarkerPayload).marker, "completed");
  assert.deepEqual(channel.delivered, ["Job finished: ok"]);

  // The settled result reached the transcript as a tool-result.
  const messages = await agent.engine.view().query({ kinds: ["message"], limit: 10 });
  const results = messages
    .map((m) => m.payload as MessagePayload)
    .flatMap((p) => p.parts)
    .filter((p) => p.type === "tool-result");
  assert.equal(results.length, 1);

  await agent.stop();
});
