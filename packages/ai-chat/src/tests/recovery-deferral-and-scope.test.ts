// Replays of the paths an independent review of the recovery engine found
// (rv-recovery): a deferred attempt must stay reachable, and only the
// attempt's own turn belongs to it.
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
  runChatRecoveryContinueCatchingForTest(
    data: Record<string, unknown>
  ): Promise<string | null>;
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

describe("a recovery attempt that hit a platform transient", () => {
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
    expect(await stub.runChatRecoveryContinueCatchingForTest(data)).toMatch(
      /Network connection lost/
    );
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
    expect(await stub.runChatRecoveryContinueCatchingForTest(data)).toMatch(
      /Network connection lost/
    );

    // Another turn continues the same reply meanwhile (the app here; a
    // client's tool answer takes the same takeReply path).
    expect((await stub.callContinueLastTurn()).status).toBe("completed");
    const afterOther = await stub.getIncidentForTest("inc-s");

    await stub.runChatRecoveryContinueDirectForTest(data);
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

describe("the recovery attempt scope", () => {
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
