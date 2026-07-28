import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SubmissionStore } from "../storage/submission-store";
import type { SubmissionEnvelope } from "../submissions";
import { submissionStoreStub } from "./test-utils";

describe("SubmissionStore", () => {
  it("retains an accepted submission after Durable Object eviction", async () => {
    // Arrange
    const stub = submissionStoreStub(`submission-${crypto.randomUUID()}`);
    const envelope: SubmissionEnvelope = {
      schemaVersion: 1,
      submissionId: "sub_01JY0N4Q5X6Z7A8B9C0D1E2F3G",
      idempotencyKey: "tenant-acme:slack:T123:event:Ev01ABC",
      agentTarget: "support-agent/acme",
      payload: {
        type: "message",
        text: "Where is order 1234?"
      },
      source: {
        type: "slack-webhook",
        id: "Ev01ABC"
      },
      createdAt: "2026-06-11T12:34:56.789Z",
      conversationHint: "slack:T123:C456:thread:1712345678.000100"
    };

    // Act
    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(state.storage.sql);
      return store.persist(envelope);
    });
    await evictDurableObject(stub);
    const restored = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(state.storage.sql);
      return store.get(envelope.submissionId);
    });

    // Assert
    expect(persisted).toEqual({ envelope, state: "pending" });
    expect(restored).toEqual({ envelope, state: "pending" });
  });
});
