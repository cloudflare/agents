import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { connectChatWS } from "./test-utils";

type Stub = {
  persistMessages(messages: unknown[]): Promise<void>;
  seedIncidentForTest(incident: Record<string, unknown>): Promise<void>;
  getIncidentForTest(
    id: string
  ): Promise<{ status: string; reason?: string } | null>;
  runChatRecoveryContinueDirectForTest(
    data: Record<string, unknown>
  ): Promise<void>;
  getOnChatMessageCallCount(): Promise<number>;
  throwFromNextTurnForTest(message: string | null): Promise<void>;
  getRecoveryRootsSeenForTest(): Promise<Array<string | null>>;
  saveFromNextResponseForTest(): Promise<void>;
  callContinueLastTurn(): Promise<{ requestId: string; status: string }>;
  waitForIdleForTest(): Promise<void>;
};

async function agent(room: string): Promise<Stub> {
  return (await getAgentByName(
    env.ChatRecoveryTestAgent,
    room
  )) as unknown as Stub;
}

async function seedCutOffReply(stub: Stub, incidentId: string, root: string) {
  await stub.persistMessages([
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "partial answ" }]
    }
  ]);
  await stub.seedIncidentForTest({
    incidentId,
    requestId: root,
    recoveryRootRequestId: root,
    recoveryKind: "continue",
    attempt: 1,
    maxAttempts: 6,
    status: "scheduled",
    firstSeenAt: Date.now(),
    lastAttemptAt: Date.now(),
    scheduled: { callback: "_chatRecoveryContinue", targetMessageId: "a1" }
  });
}

describe("rv-recovery: an attempt that hit a platform transient", () => {
  it("a stop during the redefer window is honoured by the rerun", async () => {
    const room = `rv-transient-stop-${crypto.randomUUID()}`;
    const stub = await agent(room);
    await seedCutOffReply(stub, "inc-t", "root-t");
    const data = {
      incidentId: "inc-t",
      originalRequestId: "root-t",
      targetAssistantId: "a1"
    };

    // The recovered turn's onChatMessage hits a platform transient.
    await stub.throwFromNextTurnForTest("Network connection lost.");
    await expect(
      stub.runChatRecoveryContinueDirectForTest(data)
    ).rejects.toThrow(/Network connection lost/);
    const afterThrow = await stub.getIncidentForTest("inc-t");

    // The user presses stop, by the request id it knows, while
    // dispatchChatRecoveryToHandoff's redefer waits its 3 s.
    const { ws } = await connectChatWS(
      `/agents/chat-recovery-test-agent/${room}`
    );
    ws.send(
      JSON.stringify({ type: "cf_agent_chat_request_cancel", id: "root-t" })
    );
    await new Promise((r) => setTimeout(r, 200));
    const afterStop = await stub.getIncidentForTest("inc-t");

    // The redeferred attempt runs.
    await stub.runChatRecoveryContinueDirectForTest(data);
    ws.close(1000);

    console.log(
      "RV1",
      JSON.stringify({
        afterThrow,
        afterStop,
        modelCalls: await stub.getOnChatMessageCallCount()
      })
    );
    expect({
      afterThrow,
      afterStop,
      modelCalls: await stub.getOnChatMessageCallCount()
    }).toMatchObject({
      afterThrow: expect.anything(),
      afterStop: { status: "skipped", reason: "user_cancelled" },
      // The throw was call 1. The stopped rerun must not call the model.
      modelCalls: 1
    });
  }, 20_000);

  it("a turn that continued the reply during the redefer window supersedes the rerun", async () => {
    const room = `rv-transient-supersede-${crypto.randomUUID()}`;
    const stub = await agent(room);
    await seedCutOffReply(stub, "inc-s", "root-s");
    const data = {
      incidentId: "inc-s",
      originalRequestId: "root-s",
      targetAssistantId: "a1"
    };
    await stub.throwFromNextTurnForTest("Network connection lost.");
    await expect(
      stub.runChatRecoveryContinueDirectForTest(data)
    ).rejects.toThrow(/Network connection lost/);

    // Another turn continues the same reply meanwhile (the app here; a
    // client's tool answer takes the same takeReply path).
    expect((await stub.callContinueLastTurn()).status).toBe("completed");
    const afterOther = await stub.getIncidentForTest("inc-s");

    await stub.runChatRecoveryContinueDirectForTest(data);
    console.log(
      "RV2",
      JSON.stringify({
        afterOther,
        modelCalls: await stub.getOnChatMessageCallCount(),
        final: await stub.getIncidentForTest("inc-s")
      })
    );
    expect({
      afterOther,
      modelCalls: await stub.getOnChatMessageCallCount()
    }).toMatchObject({
      afterOther: { status: "skipped", reason: "continued_by_interaction" },
      // throw + the app's continuation. The rerun must stand down.
      modelCalls: 2
    });
  }, 20_000);
});

describe("rv-recovery: the attempt scope", () => {
  it("a turn onChatResponse starts after a recovered turn is not part of the attempt", async () => {
    const room = `rv-scope-${crypto.randomUUID()}`;
    const stub = await agent(room);
    await seedCutOffReply(stub, "inc-c", "root-c");
    await stub.saveFromNextResponseForTest();
    await stub.runChatRecoveryContinueDirectForTest({
      incidentId: "inc-c",
      originalRequestId: "root-c",
      targetAssistantId: "a1"
    });
    await stub.waitForIdleForTest();
    // [recovered turn, follow-up saveMessages turn]
    expect(await stub.getRecoveryRootsSeenForTest()).toEqual(["root-c", null]);
  }, 20_000);
});

describe("rv-recovery second pass: takeReply at the commit point", () => {
  it("an app continuation whose onChatMessage throws leaves the recovery scheduled", async () => {
    const room = `rv-commit-${crypto.randomUUID()}`;
    const stub = await agent(room);
    await seedCutOffReply(stub, "inc-k", "root-k");
    await stub.throwFromNextTurnForTest("provider said no");
    await stub.callContinueLastTurn().catch(() => undefined);
    expect(await stub.getIncidentForTest("inc-k")).toMatchObject({
      status: "scheduled"
    });
  }, 20_000);
});

describe("rv-recovery second pass: schedule numbers and the initial idempotency key", () => {
  it("a second detection of the same interruption still leaves one run that continues the reply", async () => {
    const room = `rv-initial-join-${crypto.randomUUID()}`;
    const stub = (await agent(room)) as Stub & {
      rvScheduleLikeWakeForTest(id: string, target: string): Promise<void>;
      rvIncidentRawForTest(id: string): Promise<Record<string, unknown>>;
      getRecoveryTransportCountsForTest(
        callback: string
      ): Promise<{ tasks: number; schedules: number }>;
      runScheduledRecoveryContinueForTest(): Promise<void>;
    };
    await seedCutOffReply(stub, "inc-j", "root-j");
    // Two detections of the same cut-off turn (a deploy storm wakes the
    // chat-turn recovery twice before the scheduled run fires). Both use
    // reason "initial", so Tasks joins the second onto the first run.
    await stub.rvScheduleLikeWakeForTest("inc-j", "a1");
    await stub.rvScheduleLikeWakeForTest("inc-j", "a1");
    const counts = await stub.getRecoveryTransportCountsForTest(
      "_chatRecoveryContinue"
    );
    const before = await stub.rvIncidentRawForTest("inc-j");
    // Run every queued run, oldest first: the older schedule's is stale.
    for (let i = 0; i < counts.tasks; i++) {
      await stub.runScheduledRecoveryContinueForTest();
    }
    const after = await stub.getIncidentForTest("inc-j");
    console.log(
      "RV3",
      JSON.stringify({
        counts,
        scheduleCount: before.scheduleCount,
        modelCalls: await stub.getOnChatMessageCallCount(),
        after
      })
    );
    expect(await stub.getOnChatMessageCallCount()).toBe(1);
    expect(after).toBeNull();
  }, 30_000);

  it("control: one detection continues the reply", async () => {
    const room = `rv-initial-join-${crypto.randomUUID()}`;
    const stub = (await agent(room)) as Stub & {
      rvScheduleLikeWakeForTest(id: string, target: string): Promise<void>;
      rvIncidentRawForTest(id: string): Promise<Record<string, unknown>>;
      getRecoveryTransportCountsForTest(
        callback: string
      ): Promise<{ tasks: number; schedules: number }>;
      runScheduledRecoveryContinueForTest(): Promise<void>;
    };
    await seedCutOffReply(stub, "inc-j", "root-j");
    // Two detections of the same cut-off turn (a deploy storm wakes the
    // chat-turn recovery twice before the scheduled run fires). Both use
    // reason "initial", so Tasks joins the second onto the first run.
    await stub.rvScheduleLikeWakeForTest("inc-j", "a1");
    const counts = await stub.getRecoveryTransportCountsForTest(
      "_chatRecoveryContinue"
    );
    const before = await stub.rvIncidentRawForTest("inc-j");
    await stub.runScheduledRecoveryContinueForTest();
    const after = await stub.getIncidentForTest("inc-j");
    console.log(
      "RV3c",
      JSON.stringify({
        counts,
        scheduleCount: before.scheduleCount,
        modelCalls: await stub.getOnChatMessageCallCount(),
        after
      })
    );
    expect(await stub.getOnChatMessageCallCount()).toBe(1);
    expect(after).toBeNull();
  }, 30_000);
});

describe("rv-recovery second pass: a provider error that arrives in the stream", () => {
  it("a continuation whose provider fails in-stream leaves the recovery scheduled", async () => {
    const room = `rv-commit-stream-${crypto.randomUUID()}`;
    const stub = (await agent(room)) as Stub & {
      rvContinueWithStreamErrorForTest(message: string): Promise<string>;
    };
    await seedCutOffReply(stub, "inc-e", "root-e");
    // The way a provider 401/500 reaches an AIChatAgent: onChatMessage
    // returns a Response, and the stream carries an `error` chunk.
    const status = await stub.rvContinueWithStreamErrorForTest(
      "provider rejected the request"
    );
    const incident = await stub.getIncidentForTest("inc-e");
    console.log("RV4", JSON.stringify({ status, incident }));
    expect(status).toBe("error");
    expect(incident).toMatchObject({ status: "scheduled" });
  }, 20_000);
});
