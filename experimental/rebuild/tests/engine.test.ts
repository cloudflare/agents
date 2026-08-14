/** Engine unit tests: append, query, ledger, consumers, fork. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine/engine.js";
import { systemClock } from "../src/substrate.js";
import { sqliteDb } from "./helpers.js";
import { asClaimKey, asConsumerName, asReconcilerName } from "../src/ids.js";
import type { MessagePayload, NewEntry } from "../src/contract.js";

function msg(text: string, role: "user" | "assistant" = "user"): NewEntry {
  const payload: MessagePayload = {
    kind: "message",
    v: 1,
    role,
    parts: [{ type: "text", text }]
  };
  return { origin: { module: "test" }, payload } as NewEntry;
}

test("append is atomic, ordered, and idempotent by key", async () => {
  const { engine } = createEngine(sqliteDb(), systemClock());
  const first = await engine.append([msg("a"), msg("b")], {
    idempotencyKey: "k1"
  });
  if (first.outcome !== "committed")
    assert.fail(`expected committed, got ${first.outcome}`);
  assert.equal(first.refs.length, 2);

  const dup = await engine.append([msg("a"), msg("b")], {
    idempotencyKey: "k1"
  });
  assert.equal(dup.outcome, "duplicate");

  await assert.rejects(async () => {
    await engine.append([msg("DIFFERENT")], { idempotencyKey: "k1" });
  });

  const all = await engine.view().query({ limit: 10 });
  assert.equal(all.length, 2);
  // newest-first
  assert.equal((all[0].payload as MessagePayload).parts[0].type, "text");
  assert.ok(all[0].ref.seq > all[1].ref.seq);
});

test("query enforces the boundedness invariant", async () => {
  const { engine } = createEngine(sqliteDb(), systemClock());
  await engine.append([msg("x")]);
  await assert.rejects(async () => {
    await engine.view().query({ kinds: ["message"] }); // no bound
  });
  const bounded = await engine.view().query({ kinds: ["message"], limit: 1 });
  assert.equal(bounded.length, 1);
  const since = await engine.view().query({ after: 0 });
  assert.equal(since.length, 1);
});

test("ledger claim/settle carries the action-ledger semantics", async () => {
  const { engine } = createEngine(sqliteDb(), systemClock());
  const key = asClaimKey("effect-1");
  const req = {
    key,
    effect: "tool/test",
    input: { n: 1 },
    origin: { module: "test" },
    reconcileAfterMs: 60_000,
    reconciler: asReconcilerName("tools")
  };
  const first = await engine.ledger.claim(req);
  assert.equal(first.outcome, "acquired");

  const second = await engine.ledger.claim(req);
  assert.equal(second.outcome, "duplicate-open");

  const open = await engine.ledger.openClaims();
  assert.equal(open.length, 1);

  await engine.ledger.settle(key, { status: "ok", output: 42 });
  await engine.ledger.settle(key, { status: "ok", output: 42 }); // idempotent

  const third = await engine.ledger.claim(req);
  assert.equal(third.outcome, "already-settled");
  assert.deepEqual(
    (third as { result: { output: unknown } }).result.output,
    42
  );
  assert.equal((await engine.ledger.openClaims()).length, 0);

  // Both entries exist on the log with the reserved kinds.
  const claims = await engine
    .view()
    .query({ kinds: ["effect/claimed"], limit: 5 });
  const settles = await engine
    .view()
    .query({ kinds: ["effect/settled"], limit: 5 });
  assert.equal(claims.length, 1);
  assert.equal(settles.length, 1);
});

test("durable consumers redeliver unacked batches", async () => {
  const { engine } = createEngine(sqliteDb(), systemClock());
  await engine.append([msg("one"), msg("two")]);
  const consumer = engine.consumers.consumer(asConsumerName("c1"), {
    filter: { kinds: ["message"] }
  });
  const batch1 = await consumer.pull(10);
  assert.ok(batch1 !== null);
  assert.equal(batch1.entries.length, 2);

  // Not acked: pulled again (at-least-once).
  const redelivered = await consumer.pull(10);
  assert.ok(redelivered !== null);
  assert.equal(redelivered.entries.length, 2);

  await consumer.ack(redelivered.cursor);
  assert.equal(await consumer.pull(10), null);

  await engine.append([msg("three")]);
  const batch2 = await consumer.pull(10);
  assert.ok(batch2 !== null);
  assert.equal(batch2.entries.length, 1);
});

test("fork continues the parent's sequence and isolates new entries", async () => {
  const { engine } = createEngine(sqliteDb(), systemClock());
  const result = await engine.append([msg("base1"), msg("base2")]);
  const refs = (result as { refs: readonly { seq: number; branch: string }[] })
    .refs;

  const child = await engine.fork(refs[0] as Parameters<typeof engine.fork>[0]);
  await engine.append([msg("child-only")], { branch: child });

  const childView = await engine.view(child).query({ after: 0 });
  // child sees base1 (fork point) + child-only, NOT base2
  assert.equal(childView.length, 2);
  const rootView = await engine.view().query({ after: 0 });
  assert.equal(rootView.length, 2); // base1 + base2, no child entries
});

test("blobs round-trip by reference", async () => {
  const { engine } = createEngine(sqliteDb(), systemClock());
  const bytes = new TextEncoder().encode("hello blob");
  const ref = await engine.blobs.putBlob(bytes, { mediaType: "text/plain" });
  assert.equal(ref.bytes, bytes.byteLength);
  const stream = await engine.blobs.getBlob(ref);
  const reader = stream.getReader();
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), "hello blob");
});
