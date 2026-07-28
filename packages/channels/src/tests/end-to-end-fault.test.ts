import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDeliveryCoordinator } from "../agent-delivery-coordinator";
import { AgentDispatcher, type AgentTurnRequest } from "../agent-dispatch";
import { AgentDeliveryScheduler } from "../delivery-scheduler";
import {
  SubmissionStore,
  type SubmissionStoreOptions
} from "../storage/submission-store";
import {
  acceptanceResponse,
  exampleSubmissionInput,
  submissionRequest,
  submissionStoreStub
} from "./test-utils";

const START = Date.parse("2026-06-11T12:00:00.000Z");

/**
 * Roadmap item 20: the completion gate for durable submission.
 *
 * One story, end to end: a webhook is accepted over HTTP, the first dispatch
 * fails, the runtime is destroyed and restarted, the durable schedule drives
 * a retry that the agent acknowledges, and duplicate inbound submissions at
 * every stage can neither create a second logical turn nor reopen delivery.
 */
describe("durable submission end to end", () => {
  it("survives dispatch failure, restart, and duplicate submission", async () => {
    const storeName = `e2e-${crypto.randomUUID()}`;
    const stub = submissionStoreStub(storeName);
    const time = { now: START };
    const storeOptions: SubmissionStoreOptions = {
      clock: () => time.now,
      random: () => 1,
      policy: { baseRetryDelayMs: 1_000, maxRetryDelayMs: 60_000 }
    };
    const body = JSON.stringify(exampleSubmissionInput());

    // A fake agent that fails its first receipt, then acknowledges — and
    // deduplicates receipts on the stable turn ID like a real agent must.
    const turnsSeen = new Map<string, number>();
    let failuresRemaining = 1;
    const receiver = {
      async receiveTurn(request: AgentTurnRequest) {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("connection reset while contacting agent");
        }
        turnsSeen.set(request.turnId, (turnsSeen.get(request.turnId) ?? 0) + 1);
        return { turnId: request.turnId };
      }
    };
    const alarms: number[] = [];
    const makeScheduler = (store: SubmissionStore) =>
      new AgentDeliveryScheduler(
        store,
        new AgentDeliveryCoordinator(
          store,
          new AgentDispatcher(() => receiver)
        ),
        { setAlarm: (scheduledTimeMs) => void alarms.push(scheduledTimeMs) }
      );

    // 1. Acceptance over the HTTP boundary is acknowledged durably.
    const accepted = await acceptanceResponse(
      storeName,
      submissionRequest(body),
      storeOptions
    );
    expect(accepted.status).toBe(202);
    const { submissionId } = (await accepted.json()) as {
      submissionId: string;
    };

    // 2. The first dispatch fails; the retry schedule is persisted.
    const firstPass = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const store = new SubmissionStore(state.storage, storeOptions);
        const attempts = await makeScheduler(store).deliverDue();
        return { attempts, status: store.getStatus(submissionId) };
      }
    );
    expect(firstPass.attempts[0]).toMatchObject({
      attemptNumber: 1,
      outcome: "retryable_error"
    });
    expect(firstPass.status).toMatchObject({
      state: "retrying",
      nextAttemptAt: new Date(START + 1_000).toISOString()
    });
    expect(alarms).toContain(START + 1_000);

    // 3. The runtime restarts, losing every in-memory timer and instance.
    await evictDurableObject(stub);

    // 4. A duplicate inbound submission while retrying returns the original
    //    identity and does not create a second logical turn.
    const duplicateWhileRetrying = await acceptanceResponse(
      storeName,
      submissionRequest(body),
      storeOptions
    );
    expect(duplicateWhileRetrying.status).toBe(200);
    expect(await duplicateWhileRetrying.json()).toEqual({
      outcome: "duplicate",
      submissionId
    });

    // 5. After the restart, the durable schedule alone drives the retry, and
    //    the agent acknowledges the same stable turn on attempt two.
    time.now = START + 1_000;
    const secondPass = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const store = new SubmissionStore(state.storage, storeOptions);
        const dueBefore = store.listDueSubmissions();
        const attempts = await makeScheduler(store).deliverDue();
        return {
          dueBefore,
          attempts,
          status: store.getStatus(submissionId),
          allAttempts: store.listAgentDeliveryAttempts(submissionId),
          turnId: store.getAgentDelivery(submissionId)?.turnId
        };
      }
    );
    expect(secondPass.dueBefore).toEqual([submissionId]);
    expect(secondPass.attempts[0]).toMatchObject({
      attemptNumber: 2,
      outcome: "acknowledged"
    });
    expect(secondPass.status).toMatchObject({
      state: "delivered",
      attemptCount: 2,
      lastOutcome: "acknowledged"
    });
    // Both physical attempts delivered the same logical turn.
    expect(secondPass.allAttempts.map((attempt) => attempt.turnId)).toEqual([
      secondPass.turnId,
      secondPass.turnId
    ]);
    expect(turnsSeen.get(secondPass.turnId ?? "")).toBe(1);

    // 6. A duplicate after delivery still recognizes the original submission
    //    and does not reopen delivery or re-invoke the agent.
    const duplicateAfterDelivery = await acceptanceResponse(
      storeName,
      submissionRequest(body),
      storeOptions
    );
    expect(duplicateAfterDelivery.status).toBe(200);
    expect(await duplicateAfterDelivery.json()).toEqual({
      outcome: "duplicate",
      submissionId
    });
    const finalState = await runInDurableObject(stub, (_instance, state) => {
      const store = new SubmissionStore(state.storage, storeOptions);
      return {
        status: store.getStatus(submissionId),
        due: store.listDueSubmissions()
      };
    });
    expect(finalState.status).toMatchObject({
      state: "delivered",
      attemptCount: 2
    });
    expect(finalState.due).toEqual([]);
    expect([...turnsSeen.values()]).toEqual([1]);

    // 7. The submission status is retrievable over the HTTP boundary without
    //    exposing the payload.
    const statusResponse = await acceptanceResponse(
      storeName,
      new Request(`https://channels.example/${submissionId}`),
      storeOptions
    );
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      submissionId,
      state: "delivered",
      attemptCount: 2
    });
    expect(JSON.stringify(status)).not.toContain("Where is order 1234?");
  });
});
