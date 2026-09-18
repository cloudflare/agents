import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { TaskReceipt } from "agents/tasks";
import { describe, expect, it } from "vitest";
import type { AudienceReceipt, BriefRun, NoteReceipt } from "../server";

type AgentStub = {
  __unsafe_ensureInitialized(): Promise<void>;
  startBrief(topic: string, requestId: string): Promise<TaskReceipt>;
  getBrief(runId: string): Promise<BriefRun | null>;
  sendNote(
    runId: string,
    text: string,
    deliveryId: string
  ): Promise<NoteReceipt>;
  answerAudience(runId: string, audience: string): Promise<AudienceReceipt>;
  cancelBrief(runId: string): Promise<boolean>;
};

async function testAgent() {
  const stub = env.TaskEventsAgent.getByName(crypto.randomUUID());
  const agent = stub as unknown as AgentStub;
  await agent.__unsafe_ensureInitialized();
  return { agent, stub };
}

async function waitForRun(
  agent: AgentStub,
  runId: string,
  predicate: (run: BriefRun) => boolean
): Promise<BriefRun> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = await agent.getBrief(runId);
    if (run && predicate(run)) return run;
    await scheduler.wait(50);
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

describe("the task event desk", () => {
  it("buffers notes during active work and reviews them in FIFO order", async () => {
    const { agent } = await testAgent();
    const receipt = await agent.startBrief(
      "Durable task events",
      crypto.randomUUID()
    );

    await waitForRun(
      agent,
      receipt.runId,
      (run) =>
        run.state === "running" &&
        run.statusMessage?.startsWith("Researching") === true
    );

    const firstKey = crypto.randomUUID();
    const first = await agent.sendNote(
      receipt.runId,
      "Lead with the mailbox guarantee.",
      firstKey
    );
    const duplicate = await agent.sendNote(
      receipt.runId,
      "Lead with the mailbox guarantee.",
      firstKey
    );
    const second = await agent.sendNote(
      receipt.runId,
      "Mention that consumption is replay-safe.",
      crypto.randomUUID()
    );

    expect(first.accepted).toBe(true);
    expect(duplicate).toMatchObject({
      accepted: false,
      eventId: first.eventId
    });
    expect(second.accepted).toBe(true);

    await waitForRun(
      agent,
      receipt.runId,
      (run) => run.state === "waiting" && run.reason === "event"
    );

    const audience = await agent.answerAudience(
      receipt.runId,
      "engineering leaders"
    );
    const audienceRetry = await agent.answerAudience(
      receipt.runId,
      "engineering leaders"
    );
    expect(audience.accepted).toBe(true);
    expect(audienceRetry).toMatchObject({
      accepted: false,
      eventId: audience.eventId
    });

    const completed = await waitForRun(
      agent,
      receipt.runId,
      (run) => run.state === "completed"
    );
    if (completed.state !== "completed") {
      throw new Error("Expected a completed run");
    }

    expect(completed.result.audience.payload.audience).toBe(
      "engineering leaders"
    );
    expect(completed.result.notes.map((note) => note.eventId)).toEqual([
      first.eventId,
      second.eventId
    ]);
    expect(completed.result.notes.map((note) => note.payload.text)).toEqual([
      "Lead with the mailbox guarantee.",
      "Mention that consumption is replay-safe."
    ]);
  });

  it("supports cooperative cancellation", async () => {
    const { agent } = await testAgent();
    const receipt = await agent.startBrief("Cancellation", crypto.randomUUID());

    await waitForRun(
      agent,
      receipt.runId,
      (run) =>
        run.state === "running" &&
        run.statusMessage?.startsWith("Researching") === true
    );
    expect(await agent.cancelBrief(receipt.runId)).toBe(true);
    const cancelled = await waitForRun(
      agent,
      receipt.runId,
      (run) => run.state === "cancelled"
    );
    expect(cancelled).toMatchObject({
      state: "cancelled",
      reason: "Cancelled from the task event demo"
    });
  });

  it("caps unique notes without breaking idempotent retries", async () => {
    const { agent, stub } = await testAgent();
    const receipt = await agent.startBrief(
      "Bounded notes",
      crypto.randomUUID()
    );
    await waitForRun(agent, receipt.runId, (run) => run.state === "running");

    const firstDeliveryId = crypto.randomUUID();
    const first = await agent.sendNote(
      receipt.runId,
      "Note 1",
      firstDeliveryId
    );
    for (let index = 2; index <= 10; index++) {
      await agent.sendNote(receipt.runId, `Note ${index}`, crypto.randomUUID());
    }

    const limitError = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.sendNote(receipt.runId, "Note 11", crypto.randomUUID());
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    });
    expect(limitError).toBe("A brief accepts at most 10 notes.");
    const retry = await agent.sendNote(
      receipt.runId,
      "Note 1",
      firstDeliveryId
    );
    expect(retry.accepted).toBe(false);
    expect(retry.eventId).toBe(first.eventId);

    expect(await agent.cancelBrief(receipt.runId)).toBe(true);
  });
});
