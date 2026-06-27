/**
 * Durable Object eviction tests for the VoiceAgent mixin.
 *
 * VoiceAgent is a Durable Object. Its conversation history lives in the
 * `cf_voice_messages` SQL table (durable storage), while the per-instance
 * `#schemaReady` flag and the AudioConnectionManager are NON-durable in-memory
 * state. In production an idle DO is evicted from memory: in-memory state is
 * dropped and must be rebuilt from storage on next access.
 *
 * These tests use `evictDurableObject(stub)` / `evictAllDurableObjects()` from
 * "cloudflare:test" to simulate that lifecycle and PROVE that:
 *
 *   1. SQL-backed conversation history survives eviction and rehydrates.
 *   2. The cached in-memory `#schemaReady` flag is rebuilt on next access
 *      without losing rows (the first post-eviction query re-runs
 *      `#ensureSchema()` and still reads the surviving rows).
 *   3. Rows accumulate across the eviction boundary instead of resetting.
 *   4. `getConversationHistory()` reconstructs the full ordered transcript
 *      from storage after the instance has been torn down.
 *   5. Per-instance histories stay isolated across `evictAllDurableObjects()`.
 *
 * We drive the DO via `runInDurableObject` (the same idiom the agents package
 * uses) rather than a WebSocket. A `worker.fetch` WebSocket upgrade leaves an
 * in-flight request pinned to the worker's execution context, which the
 * eviction drain step waits on indefinitely; `runInDurableObject` accesses the
 * instance directly so eviction can drain and complete.
 */
import { env } from "cloudflare:workers";
import {
  evictAllDurableObjects,
  evictDurableObject,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestVoiceAgent } from "./agents/voice";

// --- Helpers ---

let instanceCounter = 0;
function uniqueName(prefix: string) {
  return `${prefix}-${++instanceCounter}`;
}

function voiceStub(name: string) {
  const id = env.TestVoiceAgent.idFromName(name);
  return env.TestVoiceAgent.get(id) as DurableObjectStub<TestVoiceAgent>;
}

/** Seed N full turns (user + assistant rows) into the DO's SQL storage. */
async function seedTurns(
  stub: DurableObjectStub<TestVoiceAgent>,
  turns: Array<{ user: string; assistant: string }>
): Promise<number> {
  return runInDurableObject(stub, (instance) => {
    for (const turn of turns) {
      instance.saveMessage("user", turn.user);
      instance.saveMessage("assistant", turn.assistant);
    }
    return instance.getMessageCount();
  });
}

async function readCount(
  stub: DurableObjectStub<TestVoiceAgent>
): Promise<number> {
  return runInDurableObject(stub, (instance) => instance.getMessageCount());
}

async function readHistory(
  stub: DurableObjectStub<TestVoiceAgent>
): Promise<Array<{ role: string; content: string }>> {
  return runInDurableObject(stub, (instance) =>
    instance.getConversationHistory()
  );
}

// --- Tests ---

describe("VoiceAgent — conversation history survives DO eviction", () => {
  it("rehydrates SQL-backed message count after evictDurableObject", async () => {
    const name = uniqueName("evict-history");
    const stub = voiceStub(name);

    // Build real durable state: one user + one assistant row. This also
    // creates the cf_voice_messages table and flips the in-memory
    // #schemaReady flag to true on THIS instance.
    const seeded = await seedTurns(stub, [
      { user: "hello", assistant: "Echo: hello" }
    ]);
    expect(seeded).toBe(2);

    // Simulate production hibernation/eviction: the instance is torn down, so
    // the cached #schemaReady flag is lost. Only durable SQL storage remains.
    await evictDurableObject(stub);

    // First access on the fresh instance must re-run #ensureSchema() (flag was
    // reset) and still see the rows that survived in storage.
    expect(await readCount(stub)).toBe(2);
  });

  it("reconstructs the full ordered transcript from storage after eviction", async () => {
    const name = uniqueName("evict-transcript");
    const stub = voiceStub(name);

    await seedTurns(stub, [
      { user: "what's the weather?", assistant: "Echo: what's the weather?" },
      { user: "and tomorrow?", assistant: "Echo: and tomorrow?" }
    ]);

    await evictDurableObject(stub);

    // getConversationHistory() rebuilds the ordered transcript purely from SQL
    // on a torn-down-and-rehydrated instance.
    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "what's the weather?" },
      { role: "assistant", content: "Echo: what's the weather?" },
      { role: "user", content: "and tomorrow?" },
      { role: "assistant", content: "Echo: and tomorrow?" }
    ]);
  });

  it("accumulates rows across an eviction boundary instead of resetting", async () => {
    const name = uniqueName("evict-accumulate");
    const stub = voiceStub(name);

    // Two turns before eviction -> 4 rows.
    await seedTurns(stub, [
      { user: "turn one", assistant: "Echo: turn one" },
      { user: "turn two", assistant: "Echo: turn two" }
    ]);

    await evictDurableObject(stub);

    // Rows survived...
    expect(await readCount(stub)).toBe(4);

    // ...and a new turn on the rehydrated instance appends (5th + 6th rows)
    // rather than starting from an empty table.
    const afterAppend = await seedTurns(stub, [
      { user: "turn three", assistant: "Echo: turn three" }
    ]);
    expect(afterAppend).toBe(6);

    const history = await readHistory(stub);
    expect(history).toHaveLength(6);
    expect(history.at(-1)).toEqual({
      role: "assistant",
      content: "Echo: turn three"
    });
  });

  it("survives repeated eviction cycles without losing or duplicating rows", async () => {
    const name = uniqueName("evict-repeat");
    const stub = voiceStub(name);

    await seedTurns(stub, [
      { user: "persist me", assistant: "Echo: persist me" }
    ]);

    // Evict and re-read several times; the count must stay stable at 2 and the
    // idempotent CREATE TABLE IF NOT EXISTS must not wipe data on rehydration.
    for (let cycle = 0; cycle < 3; cycle++) {
      await evictDurableObject(stub);
      expect(await readCount(stub)).toBe(2);
    }
  });
});

describe("VoiceAgent — evictAllDurableObjects keeps instances isolated", () => {
  it("rehydrates each instance's own history after a global eviction", async () => {
    const nameA = uniqueName("evict-all-a");
    const nameB = uniqueName("evict-all-b");
    const stubA = voiceStub(nameA);
    const stubB = voiceStub(nameB);

    // Instance A: one turn -> 2 rows.
    await seedTurns(stubA, [{ user: "a-user", assistant: "Echo: a-user" }]);
    // Instance B: two turns -> 4 rows.
    await seedTurns(stubB, [
      { user: "b-user-1", assistant: "Echo: b-user-1" },
      { user: "b-user-2", assistant: "Echo: b-user-2" }
    ]);

    // Evict every running DO at once.
    await evictAllDurableObjects();

    // Each instance rebuilds only its own rows — no cross-contamination.
    expect(await readCount(stubA)).toBe(2);
    expect(await readCount(stubB)).toBe(4);

    expect(await readHistory(stubA)).toEqual([
      { role: "user", content: "a-user" },
      { role: "assistant", content: "Echo: a-user" }
    ]);
  });
});
