import { runInDurableObject } from "cloudflare:test";
import type { AiSdkHarnessObject } from "../capabilities/ai-sdk-harness";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  TranscriptMessage,
  TurnStatus
} from "../../experimental/channels";
import {
  WEB_IDENTITY_HEADER,
  type ServerFrame
} from "../../experimental/channels/web";

type Agent = DurableObjectStub<AiSdkHarnessObject>;

function agent(): Agent {
  return env.AiSdkHarnessObject.getByName(crypto.randomUUID());
}

type Client = {
  send(event: object): void;
  /** Read frames until one matches, dropping the rest. */
  until<T extends ServerFrame>(
    match: (frame: ServerFrame) => frame is T
  ): Promise<T>;
  until(match: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  snapshot: Extract<ServerFrame, { type: "channels:snapshot" }>;
};

async function connect(stub: Agent, participant = "alice"): Promise<Client> {
  const response = await stub.fetch("https://example.com/channels", {
    headers: {
      Upgrade: "websocket",
      [WEB_IDENTITY_HEADER]: JSON.stringify({
        route: "room",
        participant: { id: participant }
      })
    }
  });
  const socket = response.webSocket as WebSocket;
  socket.accept();
  const frames: ServerFrame[] = [];
  let wake: (() => void) | undefined;
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as ServerFrame;
    if (!frame.type.startsWith("channels:")) return;
    frames.push(frame);
    wake?.();
  });
  const until = async (match: (frame: ServerFrame) => boolean) => {
    for (;;) {
      const frame = frames.shift();
      if (frame) {
        if (match(frame)) return frame;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  const snapshot = (await until(
    (f) => f.type === "channels:snapshot"
  )) as Client["snapshot"];
  return {
    send: (event) =>
      socket.send(JSON.stringify({ type: "channels:event", event })),
    until: until as Client["until"],
    snapshot
  };
}

function message(eventId: string, text: string) {
  return {
    type: "message",
    eventId,
    message: { id: eventId, role: "user", parts: [{ type: "text", text }] }
  };
}

const turnFrame =
  (turnId: string, test: (turn: TurnStatus) => boolean) =>
  (
    frame: ServerFrame
  ): frame is Extract<ServerFrame, { type: "channels:turn" }> =>
    frame.type === "channels:turn" &&
    frame.turn.turnId === turnId &&
    test(frame.turn);

const settled = (turnId: string) =>
  turnFrame(turnId, (turn) => turn.status === "settled");

const messagesWith =
  (test: (message: TranscriptMessage) => boolean) =>
  (
    frame: ServerFrame
  ): frame is Extract<ServerFrame, { type: "channels:messages" }> =>
    frame.type === "channels:messages" && frame.messages.some(test);

describe("An AI SDK harness served through Channels", () => {
  it("answers a message and saves the reply", async () => {
    const stub = agent();
    await stub.setScript([{ text: "Hello there" }]);
    const alice = await connect(stub);
    expect(alice.snapshot).toMatchObject({
      conversationId: "main",
      messages: [],
      turns: []
    });

    alice.send(message("e1", "hi"));
    const reply = await alice.until(
      messagesWith((m) => m.role === "assistant")
    );
    expect(reply.messages[0].parts).toEqual([
      { type: "text", text: "Hello there" }
    ]);
    const done = await alice.until(settled("e1"));
    expect(done.turn).toMatchObject({
      outcome: "completed",
      messageIds: [reply.messages[0].id]
    });
    expect(await stub.wait("main", "e1")).toMatchObject({
      status: "done",
      text: "Hello there"
    });

    // A new connection sees the saved transcript.
    const bob = await connect(stub, "bob");
    expect(bob.snapshot.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant"
    ]);
  });

  it("shapes earlier tool results with toModelOutput on later turns", async () => {
    const stub = agent();
    await stub.setScript([
      { call: "lookUp", toolCallId: "c1" },
      { text: "Found it" },
      { text: "Still here" }
    ]);
    await stub.submit("main", "look it up", "o1");
    expect(await stub.wait("main", "o1")).toMatchObject({ status: "done" });
    await stub.submit("main", "and again", "o2");
    expect(await stub.wait("main", "o2")).toMatchObject({ status: "done" });

    // The third call rebuilds the history from the saved transcript.
    const prompt = await stub.getPrompt(2);
    expect(prompt).toContain("shaped for the model");
    expect(prompt).not.toContain("full host-side output");
  });

  it("queues a message sent while a turn runs", async () => {
    const stub = agent();
    await stub.setScript([{ text: "first", delayMs: 20 }, { text: "second" }]);
    const alice = await connect(stub);
    alice.send(message("e1", "one"));
    alice.send(message("e2", "two"));
    await alice.until(turnFrame("e2", (turn) => turn.status === "queued"));
    await alice.until(settled("e1"));
    const second = await alice.until(settled("e2"));
    expect(second.turn).toMatchObject({ outcome: "completed" });
    const state = await stub.state("main");
    expect(state.messages.map((m) => m.parts[0])).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "first" },
      { type: "text", text: "two" },
      { type: "text", text: "second" }
    ]);
  });

  it("waits for an approval, then continues the same message", async () => {
    const stub = agent();
    await stub.setScript([
      { call: "flipCoin", toolCallId: "c1" },
      { text: "It was heads" }
    ]);
    const alice = await connect(stub);
    alice.send(message("e1", "flip"));
    const asked = await alice.until(
      messagesWith((m) =>
        m.parts.some(
          (p) => p.type === "tool" && p.state === "approval-requested"
        )
      )
    );
    const call = asked.messages[0];
    const waiting = await alice.until(settled("e1"));
    expect(waiting.turn).toMatchObject({ outcome: "awaiting-input" });

    const tool = call.parts.find((p) => p.type === "tool");
    const approvalId = tool?.type === "tool" ? tool.approval?.id : undefined;
    alice.send({
      type: "approval-response",
      eventId: "a1",
      turnId: "e1",
      approvalId,
      approved: true
    });
    const running = await alice.until(
      turnFrame("e1", (turn) => turn.status === "running")
    );
    expect(running.turn).toMatchObject({ extends: call.id });
    const done = await alice.until(settled("e1"));
    expect(done.turn).toMatchObject({ outcome: "completed" });

    const state = await stub.state("main");
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].id).toBe(call.id);
    expect(state.messages[1].parts).toEqual([
      expect.objectContaining({
        type: "tool",
        state: "output-available",
        output: "Heads"
      }),
      { type: "text", text: "It was heads" }
    ]);
  });

  it("takes a client tool's result only from the participant who asked", async () => {
    const stub = agent();
    await stub.setScript([
      { call: "getLocation", toolCallId: "c1" },
      { text: "You are in Lisbon" }
    ]);
    const alice = await connect(stub, "alice");
    const bob = await connect(stub, "bob");
    alice.send(message("e1", "where am I?"));
    const asked = await alice.until(
      messagesWith((m) =>
        m.parts.some((p) => p.type === "tool" && p.state === "input-available")
      )
    );
    expect(asked.messages[0].parts[0]).toMatchObject({ owner: "alice" });
    await alice.until(settled("e1"));

    const result = (eventId: string) => ({
      type: "tool-result",
      eventId,
      turnId: "e1",
      toolCallId: "c1",
      result: { ok: true, output: "Lisbon" }
    });
    bob.send(result("r1"));
    await bob.until((f) => f.type === "channels:ack" && f.eventId === "r1");
    expect(await stub.wait("main", "r1")).toMatchObject({
      status: "unanswered",
      reason: "not_owner"
    });
    // The turn still waits for Alice's client.
    const still = await alice.until(settled("e1"));
    expect(still.turn).toMatchObject({ outcome: "awaiting-input" });

    alice.send(result("r2"));
    await alice.until((f) => f.type === "channels:ack" && f.eventId === "r2");
    expect(await stub.wait("main", "r2")).toMatchObject({ status: "done" });
    const state = await stub.state("main");
    expect(state.messages[1].parts.at(-1)).toEqual({
      type: "text",
      text: "You are in Lisbon"
    });
  });

  it("starts with unsettled work in several sessions", async () => {
    const stub = agent();
    await stub.setScript([
      { text: "a", delayMs: 300 },
      { text: "b", delayMs: 300 }
    ]);
    await stub.submit("a", "hi", "op-a");
    await stub.submit("b", "hi", "op-b");
    // What a restart runs: walk the stored sessions and wake the busy ones.
    await runInDurableObject(stub, (instance: AiSdkHarnessObject) =>
      instance.harness.onStart()
    );
    expect(await stub.wait("a", "op-a")).toMatchObject({ status: "done" });
    expect(await stub.wait("b", "op-b")).toMatchObject({ status: "done" });
  });

  it("rejects a wait whose signal is already aborted", async () => {
    const stub = agent();
    await stub.setScript([{ text: "slow", held: true }]);
    await stub.submit("main", "hi", "o1");
    // Held, so o1 is still pending when the wait begins.
    expect(await stub.waitAborted("main", "o1")).toBe("rejected");
    await stub.release();
    expect(await stub.wait("main", "o1")).toMatchObject({ status: "done" });
  });

  it("forks a conversation with its history", async () => {
    const stub = agent();
    await stub.setScript([{ text: "first" }]);
    const alice = await connect(stub);
    alice.send(message("e1", "one"));
    await alice.until(settled("e1"));
    alice.send({ type: "conversation-fork", eventId: "f1" });
    const fork = await alice.until((f) => f.type === "channels:snapshot");
    expect(fork.conversationId).not.toBe("main");
    expect(fork.type === "channels:snapshot" && fork.messages).toHaveLength(2);
  });
});
