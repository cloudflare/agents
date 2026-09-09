/**
 * Forced Durable Object eviction coverage for VoiceAgent conversation storage.
 *
 * The test fixture disables WebSocket hibernation, so this intentionally tests
 * only actor reconstruction after explicit eviction. It does not assert natural
 * idle hibernation or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import {
  evictAllDurableObjects,
  evictDurableObject,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestVoiceAgent } from "./agents/voice";

type History = Array<{ role: string; content: string }>;

function voiceStub(name: string) {
  return env.TestVoiceAgent.get(
    env.TestVoiceAgent.idFromName(name)
  ) as DurableObjectStub<TestVoiceAgent>;
}

async function appendTurns(
  stub: DurableObjectStub<TestVoiceAgent>,
  turns: Array<{ user: string; assistant: string }>
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    for (const turn of turns) {
      instance.saveMessage("user", turn.user);
      instance.saveMessage("assistant", turn.assistant);
    }
  });
}

async function readHistory(
  stub: DurableObjectStub<TestVoiceAgent>
): Promise<History> {
  return runInDurableObject(stub, (instance) =>
    instance.getConversationHistory()
  );
}

describe("VoiceAgent recovery after forced Durable Object eviction", () => {
  it("restores and extends the exact ordered transcript", async () => {
    const stub = voiceStub(`evict-voice-${crypto.randomUUID()}`);
    await appendTurns(stub, [
      { user: "what's the weather?", assistant: "Sunny" },
      { user: "and tomorrow?", assistant: "Rain" }
    ]);

    await evictDurableObject(stub);

    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "what's the weather?" },
      { role: "assistant", content: "Sunny" },
      { role: "user", content: "and tomorrow?" },
      { role: "assistant", content: "Rain" }
    ]);

    // The first write on the fresh instance re-runs the schema guard and must
    // append to, rather than replace, the rows created before eviction.
    await appendTurns(stub, [{ user: "weekend?", assistant: "Clear" }]);
    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "what's the weather?" },
      { role: "assistant", content: "Sunny" },
      { role: "user", content: "and tomorrow?" },
      { role: "assistant", content: "Rain" },
      { role: "user", content: "weekend?" },
      { role: "assistant", content: "Clear" }
    ]);
  });

  it("keeps named transcripts isolated after a global forced eviction", async () => {
    const stubA = voiceStub(`evict-voice-a-${crypto.randomUUID()}`);
    const stubB = voiceStub(`evict-voice-b-${crypto.randomUUID()}`);
    await appendTurns(stubA, [{ user: "A", assistant: "A reply" }]);
    await appendTurns(stubB, [{ user: "B", assistant: "B reply" }]);

    await evictAllDurableObjects();

    expect(await readHistory(stubA)).toEqual([
      { role: "user", content: "A" },
      { role: "assistant", content: "A reply" }
    ]);
    expect(await readHistory(stubB)).toEqual([
      { role: "user", content: "B" },
      { role: "assistant", content: "B reply" }
    ]);
  });
});
