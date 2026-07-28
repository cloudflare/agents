import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SubmissionStore } from "../storage/submission-store";
import type { SubmissionInput } from "../submissions";
import { exampleSubmissionInput, submissionStoreStub } from "./test-utils";

type CountRow = Record<string, SqlStorageValue> & { count: number };

describe("SubmissionStore", () => {
  it("atomically returns one identity for repeated acceptance", async () => {
    // Arrange
    const stub = submissionStoreStub(`acceptance-${crypto.randomUUID()}`);
    const input = exampleSubmissionInput();

    // Act
    const [first, second] = await Promise.all([
      runInDurableObject(stub, (_instance, state) =>
        new SubmissionStore(state.storage).accept(input)
      ),
      runInDurableObject(stub, (_instance, state) =>
        new SubmissionStore(state.storage).accept(input)
      )
    ]);
    if (first.outcome === "conflict" || second.outcome === "conflict") {
      throw new Error("Equivalent input must not conflict");
    }
    const ledger = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(state.storage);
      const [{ count }] = state.storage.sql
        .exec<CountRow>(
          "SELECT COUNT(*) AS count FROM cf_channels_agent_deliveries"
        )
        .toArray();
      return {
        submission: store.get(first.submissionId),
        delivery: store.getAgentDelivery(first.submissionId),
        deliveryCount: count
      };
    });

    // Assert
    expect([first.outcome, second.outcome].sort()).toEqual([
      "accepted",
      "duplicate"
    ]);
    expect(second.submissionId).toBe(first.submissionId);
    expect(ledger.submission).toMatchObject({
      envelope: input,
      state: "pending"
    });
    expect(ledger.delivery).toMatchObject({
      submissionId: first.submissionId,
      turnId: expect.stringMatching(/^turn_/)
    });
    expect(ledger.deliveryCount).toBe(1);
  });

  it("treats reordered JSON object properties as equivalent", async () => {
    // Arrange
    const stub = submissionStoreStub(`equivalent-${crypto.randomUUID()}`);
    const original = exampleSubmissionInput({
      payload: {
        type: "message",
        metadata: { priority: 1, internal: false }
      }
    });
    const reordered: SubmissionInput = {
      conversationHint: original.conversationHint,
      source: { id: original.source.id, type: original.source.type },
      payload: {
        metadata: { internal: false, priority: 1 },
        type: "message"
      },
      agentTarget: original.agentTarget,
      idempotencyKey: original.idempotencyKey
    };

    // Act
    const [accepted, duplicate] = await runInDurableObject(
      stub,
      (_instance, state) => {
        const store = new SubmissionStore(state.storage);
        return [store.accept(original), store.accept(reordered)];
      }
    );

    // Assert
    expect(accepted.outcome).toBe("accepted");
    if (accepted.outcome !== "accepted") {
      throw new Error("Expected the first call to accept the submission");
    }
    expect(duplicate).toEqual({
      outcome: "duplicate",
      submissionId: accepted.submissionId
    });
  });

  it.each<{
    name: string;
    change: (input: SubmissionInput) => SubmissionInput;
  }>([
    {
      name: "agent target",
      change: (input) => ({ ...input, agentTarget: "another-agent" })
    },
    {
      name: "payload",
      change: (input) => ({ ...input, payload: { text: "Changed" } })
    },
    {
      name: "source",
      change: (input) => ({
        ...input,
        source: { ...input.source, id: "another-event" }
      })
    },
    {
      name: "conversation hint",
      change: (input) => ({ ...input, conversationHint: "another-thread" })
    }
  ])("rejects key reuse with a different $name", async ({ change }) => {
    // Arrange
    const stub = submissionStoreStub(`conflict-${crypto.randomUUID()}`);
    const original = exampleSubmissionInput();

    // Act
    const [accepted, conflict] = await runInDurableObject(
      stub,
      (_instance, state) => {
        const store = new SubmissionStore(state.storage);
        return [store.accept(original), store.accept(change(original))];
      }
    );
    if (accepted.outcome !== "accepted") {
      throw new Error("Expected the first call to accept the submission");
    }
    const stored = await runInDurableObject(stub, (_instance, state) =>
      new SubmissionStore(state.storage).get(accepted.submissionId)
    );

    // Assert
    expect(accepted.outcome).toBe("accepted");
    expect(conflict).toEqual({ outcome: "conflict" });
    expect(stored?.envelope).toMatchObject(original);
  });

  it("rolls back the submission when logical delivery creation fails", async () => {
    // Arrange
    const stub = submissionStoreStub(`rollback-${crypto.randomUUID()}`);
    const input = exampleSubmissionInput();

    // Act
    const result = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(state.storage);
      state.storage.sql.exec(`CREATE TRIGGER fail_agent_delivery
        BEFORE INSERT ON cf_channels_agent_deliveries
        BEGIN
          SELECT RAISE(ABORT, 'simulated delivery failure');
        END`);

      let failed = false;
      try {
        store.accept(input);
      } catch {
        failed = true;
      }

      const [{ submissionCount }] = state.storage.sql
        .exec<Record<string, SqlStorageValue> & { submissionCount: number }>(
          "SELECT COUNT(*) AS submissionCount FROM cf_channels_submissions"
        )
        .toArray();
      const [{ deliveryCount }] = state.storage.sql
        .exec<Record<string, SqlStorageValue> & { deliveryCount: number }>(
          "SELECT COUNT(*) AS deliveryCount FROM cf_channels_agent_deliveries"
        )
        .toArray();
      return { deliveryCount, failed, submissionCount };
    });

    // Assert
    expect(result).toEqual({
      deliveryCount: 0,
      failed: true,
      submissionCount: 0
    });
  });

  it("retains an accepted submission after Durable Object eviction", async () => {
    // Arrange
    const stub = submissionStoreStub(`submission-${crypto.randomUUID()}`);
    const input = exampleSubmissionInput();

    // Act
    const accepted = await runInDurableObject(stub, (_instance, state) =>
      new SubmissionStore(state.storage).accept(input)
    );
    if (accepted.outcome !== "accepted") {
      throw new Error("Expected the submission to be accepted");
    }
    await evictDurableObject(stub);
    const restored = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(state.storage);
      return {
        submission: store.get(accepted.submissionId),
        delivery: store.getAgentDelivery(accepted.submissionId)
      };
    });

    // Assert
    expect(restored.submission).toMatchObject({
      envelope: input,
      state: "pending"
    });
    expect(restored.delivery).toMatchObject({
      submissionId: accepted.submissionId,
      turnId: expect.stringMatching(/^turn_/)
    });
  });
});
