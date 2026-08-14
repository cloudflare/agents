/**
 * End-to-end: channel → admission → turn → step harness → model → tools →
 * log → outbox delivery. The whole architecture, mock model, real engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { startAgent } from "../src/runtime/host.js";
import {
  MockLanguageModel,
  mockOutput,
  mockText,
  mockToolCall
} from "../src/models/mock.js";
import { sqliteDb, testAgent, testProviders } from "./helpers.js";
import type { MessagePayload, TurnMarkerPayload } from "../src/contract.js";

test("a truncated answer fails the turn instead of passing as complete", async () => {
  // Regression: finish=length used to be retried, and the retried step read
  // the committed partial answer as "already answered" and completed the
  // turn — so hitting the output cap looked exactly like success.
  const db = sqliteDb();
  const { provider } = testProviders();
  const model = new MockLanguageModel([
    mockOutput([{ type: "text", text: "It begins like th" }], "length"),
    mockText("should never be reached")
  ]);
  const { definition } = testAgent({ model, providers: [provider] });
  const agent = startAgent(definition, { db });

  await agent.engine.append(
    [
      {
        origin: { module: "channel", instance: "test" },
        payload: {
          kind: "message",
          v: 1,
          role: "user",
          parts: [{ type: "text", text: "Tell me a long story." }]
        }
      } as never
    ],
    {}
  );
  await agent.waitUntilQuiescent();

  const markers = await agent.engine
    .view()
    .query({ kinds: ["turn/marker"], limit: 10 });
  const latest = markers[0].payload as TurnMarkerPayload;
  assert.equal(latest.marker, "failed");
  assert.match(
    JSON.stringify(latest.detail),
    /output truncated.*finish=length/,
    "the failure must say why, not just that"
  );
  // The partial text is still on the log — truncated, not discarded.
  const messages = await agent.engine
    .view()
    .query({ kinds: ["message"], limit: 10 });
  const assistant = messages.find(
    (m) => (m.payload as MessagePayload).role === "assistant"
  );
  assert.ok(assistant !== undefined, "the partial answer is preserved");
  await agent.stop();
});

test("happy path: message → tool call → tool result → answer → delivery", async () => {
  const db = sqliteDb();
  const { provider } = testProviders();
  const model = new MockLanguageModel([
    mockToolCall("c1", "test/add", { a: 2, b: 3 }),
    mockText("The sum is 5.")
  ]);
  const { definition, channel } = testAgent({ model, providers: [provider] });
  const agent = startAgent(definition, { db });

  await channel.send("What is 2 + 3?");
  await agent.waitUntilQuiescent();

  // Outbox delivered the answer.
  assert.deepEqual(channel.delivered, ["The sum is 5."]);

  // The log tells the whole story.
  const view = agent.engine.view();
  const messages = await view.query({ kinds: ["message"], limit: 10 });
  const roles = messages
    .map((m) => (m.payload as MessagePayload).role)
    .reverse();
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);

  const markers = await view.query({ kinds: ["turn/marker"], limit: 10 });
  const states = markers
    .map((m) => (m.payload as TurnMarkerPayload).marker)
    .reverse();
  assert.deepEqual(states, ["admitted", "step-committed", "completed"]);

  // The model saw the tool result on its second call.
  assert.equal(model.requests.length, 2);
  const second = model.requests[1];
  const resultParts = second.messages.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool-result")
  );
  assert.equal(resultParts.length, 1);

  await agent.stop();
});

test("a second message while a turn is active queues and then runs", async () => {
  const db = sqliteDb();
  const { provider } = testProviders();
  // Model: turn 1 = slow tool then answer; turn 2 = immediate answer.
  const model = new MockLanguageModel((req, call) => {
    if (call === 0) return mockToolCall("q1", "test/add", { a: 1, b: 1 });
    const lastUser = [...req.messages]
      .reverse()
      .find((m) => m.role === "user" && m.parts.some((p) => p.type === "text"));
    const text = lastUser?.parts.find((p) => p.type === "text");
    return mockText(
      `answer to: ${text !== undefined && "text" in text ? text.text : "?"}`
    );
  });
  const { definition, channel } = testAgent({ model, providers: [provider] });
  const agent = startAgent(definition, { db });

  await channel.send("first");
  await channel.send("second");
  await agent.waitUntilQuiescent();

  assert.equal(channel.delivered.length, 2);
  assert.match(channel.delivered[1], /second/);

  // Two turns, both completed.
  const markers = await agent.engine
    .view()
    .query({ kinds: ["turn/marker"], limit: 20 });
  const completed = markers.filter(
    (m) => (m.payload as TurnMarkerPayload).marker === "completed"
  );
  assert.equal(completed.length, 2);

  await agent.stop();
});

test("readonly tools need no claim; mutating tools are ledgered", async () => {
  const db = sqliteDb();
  const { provider, effects } = testProviders();
  const model = new MockLanguageModel([
    mockToolCall("m1", "test/notify", { to: "ops" }),
    mockText("Notified.")
  ]);
  const { definition, channel } = testAgent({ model, providers: [provider] });
  const agent = startAgent(definition, { db });

  await channel.send("notify ops");
  await agent.waitUntilQuiescent();

  assert.deepEqual(effects, ['notify:{"to":"ops"}']);
  const claims = await agent.engine
    .view()
    .query({ kinds: ["effect/claimed"], limit: 5 });
  const settles = await agent.engine
    .view()
    .query({ kinds: ["effect/settled"], limit: 5 });
  assert.equal(claims.length, 1);
  assert.equal(settles.length, 1);

  await agent.stop();
});

test("a custom harness can rehydrate from TurnDeps.openClaims", async () => {
  const db = sqliteDb();
  const { provider } = testProviders();
  const seen: number[] = [];
  const { definition, channel } = testAgent({
    model: new MockLanguageModel([mockText("unused")]),
    providers: [provider]
  });
  // Swap in a minimal foreign harness: read the open-claims worklist off the
  // narrowed surface, then leave the log quiescent.
  const custom: typeof definition = {
    ...definition,
    harness: {
      async drive(deps) {
        seen.push((await deps.openClaims()).length);
        await deps.commit([
          {
            origin: { module: "harness" },
            turn: deps.turn.turnId,
            payload: {
              kind: "turn/marker",
              v: 1,
              marker: "completed",
              turnId: deps.turn.turnId,
              attempt: deps.turn.attempt
            }
          } as never
        ]);
      }
    }
  };
  const agent = startAgent(custom, { db });
  await channel.send("hello");
  await agent.waitUntilQuiescent();
  assert.deepEqual(seen, [0]); // seam reachable, empty worklist
  await agent.stop();
});
