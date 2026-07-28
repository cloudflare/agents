import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDeliveryCoordinator } from "../agent-delivery-coordinator";
import { AgentDispatcher } from "../agent-dispatch";
import { AgentDeliveryScheduler } from "../delivery-scheduler";
import {
  SubmissionStore,
  type SubmissionStoreOptions
} from "../storage/submission-store";
import { exampleSubmissionInput, submissionStoreStub } from "./test-utils";

const START = Date.parse("2026-06-11T12:00:00.000Z");

function deterministicOptions(time: { now: number }): SubmissionStoreOptions {
  return {
    clock: () => time.now,
    random: () => 1,
    policy: { baseRetryDelayMs: 1_000, maxRetryDelayMs: 60_000 }
  };
}

describe("AgentDeliveryScheduler", () => {
  it("dispatches due work and re-arms a durable alarm for the next retry", async () => {
    // Arrange
    const stub = submissionStoreStub(`scheduler-${crypto.randomUUID()}`);
    const time = { now: START };
    const alarms: number[] = [];

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      const scheduler = new AgentDeliveryScheduler(
        store,
        new AgentDeliveryCoordinator(
          store,
          new AgentDispatcher(() => ({
            async receiveTurn() {
              throw new Error("agent offline");
            }
          }))
        ),
        { setAlarm: (scheduledTimeMs) => void alarms.push(scheduledTimeMs) }
      );

      const attempts = await scheduler.deliverDue();
      const idleAttempts = await scheduler.deliverDue();
      return {
        attempts,
        idleAttempts,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ outcome: "retryable_error" });
    expect(result.status).toMatchObject({
      state: "retrying",
      nextAttemptAt: new Date(START + 1_000).toISOString()
    });
    // The wakeup is persisted as an alarm at the durable next-attempt time.
    expect(alarms).toEqual([START + 1_000, START + 1_000]);
    // Backoff means the retry is not looped inside the same pass.
    expect(result.idleAttempts).toEqual([]);
  });

  it("still delivers after eviction because the schedule is durable", async () => {
    // Arrange
    const stub = submissionStoreStub(`scheduler-evict-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act: accept and fail once, then evict the Durable Object entirely.
    const accepted = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const store = new SubmissionStore(
          state.storage,
          deterministicOptions(time)
        );
        const acceptance = store.accept(exampleSubmissionInput());
        if (acceptance.outcome !== "accepted") {
          throw new Error("Expected a new submission");
        }
        const scheduler = new AgentDeliveryScheduler(
          store,
          new AgentDeliveryCoordinator(
            store,
            new AgentDispatcher(() => ({
              async receiveTurn() {
                throw new Error("agent offline");
              }
            }))
          )
        );
        await scheduler.deliverDue();
        return acceptance;
      }
    );
    await evictDurableObject(stub);

    // A fresh runtime instance discovers the persisted retry once it is due.
    time.now = START + 1_000;
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const dueBefore = store.listDueSubmissions();
      const scheduler = new AgentDeliveryScheduler(
        store,
        new AgentDeliveryCoordinator(
          store,
          new AgentDispatcher(() => ({
            async receiveTurn(request) {
              return { turnId: request.turnId };
            }
          }))
        )
      );
      const attempts = await scheduler.deliverDue();
      const nextWake = await scheduler.scheduleNextWake();
      return {
        dueBefore,
        attempts,
        nextWake,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.dueBefore).toEqual([accepted.submissionId]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      attemptNumber: 2,
      outcome: "acknowledged"
    });
    expect(result.status?.state).toBe("delivered");
    // Nothing further is scheduled once all work is terminal.
    expect(result.nextWake).toBeUndefined();
  });

  it("recovers expired leases as part of a delivery pass", async () => {
    // Arrange
    const stub = submissionStoreStub(`scheduler-lease-${crypto.randomUUID()}`);
    const time = { now: START };

    // Act
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const store = new SubmissionStore(
        state.storage,
        deterministicOptions(time)
      );
      const accepted = store.accept(exampleSubmissionInput());
      if (accepted.outcome !== "accepted") {
        throw new Error("Expected a new submission");
      }
      // A worker claims the attempt and then crashes without completing it.
      store.beginAgentDeliveryAttempt(accepted.submissionId);
      time.now += 30_000;

      const scheduler = new AgentDeliveryScheduler(
        store,
        new AgentDeliveryCoordinator(
          store,
          new AgentDispatcher(() => ({
            async receiveTurn(request) {
              return { turnId: request.turnId };
            }
          }))
        )
      );
      await scheduler.deliverDue();
      const afterRecovery = store.getStatus(accepted.submissionId);
      time.now = Date.parse(afterRecovery?.nextAttemptAt ?? "");
      const attempts = await scheduler.deliverDue();
      return {
        afterRecovery,
        attempts,
        status: store.getStatus(accepted.submissionId)
      };
    });

    // Assert
    expect(result.afterRecovery).toMatchObject({
      state: "retrying",
      lastOutcome: "lease_expired"
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.status?.state).toBe("delivered");
  });
});
