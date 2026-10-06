import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ThinkHarnessTestObject } from "./worker";

type Stub = DurableObjectStub<ThinkHarnessTestObject>;

type Frame = {
  type: string;
  id?: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  replayComplete?: boolean;
  continuation?: boolean;
  outcome?: string;
  reason?: string;
  probeId?: string;
  messages?: {
    id: string;
    role: string;
    parts: { type: string; text?: string }[];
  }[];
};

type Client = {
  send(frame: object): void;
  /** Read frames until one matches, keeping the ones it passed over. */
  until(match: (frame: Frame) => boolean): Promise<Frame>;
  /** Every frame received so far. */
  readonly seen: Frame[];
  close(): void;
};

function fresh(name: string = crypto.randomUUID()): Stub {
  return env.THINK_HARNESS_TEST.getByName(name);
}

async function connect(stub: Stub): Promise<Client> {
  const response = await stub.fetch("https://example.com/agents/chat/x", {
    headers: { Upgrade: "websocket" }
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  socket.accept();
  const seen: Frame[] = [];
  let next = 0;
  let wake: (() => void) | undefined;
  socket.addEventListener("message", (event) => {
    seen.push(JSON.parse(String(event.data)) as Frame);
    wake?.();
  });
  return {
    seen,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
    async until(match) {
      for (;;) {
        while (next < seen.length) {
          const frame = seen[next++];
          if (frame && match(frame)) return frame;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  };
}

function chatRequest(id: string, text: string) {
  return {
    type: "cf_agent_use_chat_request",
    id,
    init: {
      method: "POST",
      body: JSON.stringify({
        trigger: "submit-message",
        messages: [
          { id: `user-${id}`, role: "user", parts: [{ type: "text", text }] }
        ]
      })
    }
  };
}

function chunkTypes(frames: readonly Frame[], id: string): string[] {
  return frames
    .filter(
      (frame) =>
        frame.type === "cf_agent_use_chat_response" &&
        frame.id === id &&
        frame.body
    )
    .map((frame) => (JSON.parse(frame.body ?? "{}") as { type: string }).type);
}

describe("ThinkChat", () => {
  it("serves the transcript over HTTP and on connect", async () => {
    const stub = fresh();
    await stub.prompt("hello");
    const response = await stub.fetch(
      "https://example.com/agents/chat/x/get-messages"
    );
    const messages = (await response.json()) as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const client = await connect(stub);
    const hello = await client.until(
      (f) => f.type === "cf_agent_chat_messages"
    );
    expect(hello.messages).toHaveLength(2);
    client.close();
  });

  it("streams a chat request's response and ends it after the transcript", async () => {
    const stub = fresh();
    const client = await connect(stub);
    client.send(chatRequest("req-1", "multiply 2"));
    const done = await client.until(
      (f) => f.type === "cf_agent_use_chat_response" && f.done === true
    );
    expect(done).toMatchObject({ id: "req-1", outcome: "completed" });
    const types = chunkTypes(client.seen, "req-1");
    expect(types[0]).toBe("start");
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
    expect(types).toContain("text-delta");
    expect(types.at(-1)).toBe("finish");
    // The transcript reaches the client before the terminal frame (#2119).
    const doneIndex = client.seen.indexOf(done);
    const transcript = client.seen
      .slice(0, doneIndex)
      .reverse()
      .find((f) => f.type === "cf_agent_chat_messages");
    expect(transcript?.messages?.at(-1)?.role).toBe("assistant");
    expect(await stub.messages()).toEqual([
      "user: multiply 2",
      "assistant: [multiply output-available] tool said: 6"
    ]);
    client.close();
  });

  it("dedupes a resent chat request by its id", async () => {
    const stub = fresh();
    const client = await connect(stub);
    client.send(chatRequest("req-1", "hello"));
    await client.until((f) => f.done === true && f.id === "req-1");
    client.send(chatRequest("req-1", "hello"));
    // The resend is answered with the same ending, and nothing runs again.
    await client.until((f) => f.done === true && f.id === "req-1");
    expect(await stub.messages()).toEqual([
      "user: hello",
      "assistant: echo: hello"
    ]);
    client.close();
  });

  it("runs a client tool through the protocol and continues", async () => {
    const stub = fresh();
    const client = await connect(stub);
    client.send(chatRequest("req-1", "client"));
    await client.until((f) => f.done === true && f.id === "req-1");
    const [call] = await stub.lastToolCalls();
    client.send({
      type: "cf_agent_tool_result",
      toolCallId: call?.toolCallId,
      toolName: "ask",
      output: "because",
      autoContinue: true
    });
    // The continuation is offered to the client that answered.
    const offer = await client.until(
      (f) => f.type === "cf_agent_stream_resuming"
    );
    client.send({ type: "cf_agent_stream_resume_ack", id: offer.id });
    const done = await client.until(
      (f) => f.done === true && f.id === offer.id
    );
    expect(done).toMatchObject({ outcome: "completed", continuation: true });
    expect((await stub.messages()).at(-1)).toBe(
      "assistant: [ask output-available] tool said: because"
    );
    client.close();
  });

  it("cancels a request", async () => {
    const stub = fresh();
    const client = await connect(stub);
    client.send(chatRequest("req-1", "slow"));
    await stub.streamed();
    client.send({ type: "cf_agent_chat_request_cancel", id: "req-1" });
    const done = await client.until((f) => f.done === true && f.id === "req-1");
    expect(done.outcome).toBe("aborted");
    client.close();
  });

  it("clears the conversation", async () => {
    const stub = fresh();
    await stub.prompt("hello");
    const client = await connect(stub);
    const other = await connect(stub);
    client.send({ type: "cf_agent_chat_clear" });
    await other.until((f) => f.type === "cf_agent_chat_clear");
    expect(await stub.messages()).toEqual([]);
    client.close();
    other.close();
  });

  it("answers a resume probe when idle", async () => {
    const stub = fresh();
    const client = await connect(stub);
    client.send({ type: "cf_agent_stream_resume_request", probeId: "p1" });
    const none = await client.until(
      (f) => f.type === "cf_agent_stream_resume_none"
    );
    expect(none).toMatchObject({ reason: "idle", probeId: "p1" });
    client.close();
  });

  it("replays a running stream to a client that reconnects, then goes live", async () => {
    const name = crypto.randomUUID();
    const stub = fresh(name);
    const first = await connect(stub);
    first.send(chatRequest("req-1", "slow"));
    await stub.streamed();

    const late = await connect(stub);
    const offer = await late.until(
      (f) => f.type === "cf_agent_stream_resuming"
    );
    expect(offer.id).toBe("req-1");
    late.send({ type: "cf_agent_stream_resume_ack", id: "req-1" });
    await late.until((f) => f.replayComplete === true);
    const replayed = late.seen.filter((f) => f.replay && f.body);
    expect(replayed.length).toBeGreaterThan(0);
    expect(JSON.parse(replayed[0]?.body ?? "{}")).toMatchObject({
      type: "start"
    });

    await stub.releaseSlow();
    const done = await late.until((f) => f.done === true && f.id === "req-1");
    expect(done.outcome).toBe("completed");
    // Live frames followed the replay.
    const live = late.seen.filter(
      (f) => f.id === "req-1" && !f.replay && f.body
    );
    expect(live.length).toBeGreaterThan(0);
    first.close();
    late.close();
  });

  it("offers the stream an eviction interrupted, rebuilt from storage", async () => {
    const name = crypto.randomUUID();
    let stub = fresh(name);
    const client = await connect(stub);
    client.send(chatRequest("req-1", "slow"));
    await stub.streamed();
    client.close();

    await abortAllDurableObjects();
    stub = fresh(name);
    await runDurableObjectAlarm(stub);
    const result = await stub.wait("req-1");
    expect(result.status).toBe("done");
    const again = await connect(stub);
    const hello = await again.until((f) => f.type === "cf_agent_chat_messages");
    expect(hello.messages?.at(-1)?.parts.at(-1)).toMatchObject({
      type: "text"
    });
    again.close();
  });
});
