import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import { PiCommandOutbox } from "../outbox";
import type { PiServerMessage } from "../protocol";
import type { PiSessionView } from "../view";

async function connect(name: string): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/pi-harness-test/${name}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

/**
 * Send every pending submit, as the hook does on open; await the `result`
 * or `error` with `id`.
 */
function replay(
  socket: WebSocket,
  outbox: PiCommandOutbox,
  id: string
): Promise<PiServerMessage> {
  const answered = new Promise<PiServerMessage>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as PiServerMessage;
      if (
        (message.type === "result" || message.type === "error") &&
        message.id === id
      ) {
        resolve(message);
      }
    });
  });
  outbox.sendPending((data) => socket.send(data));
  return answered;
}

describe("the client command outbox", () => {
  it("names each submit with an operation id and keeps it until a result", () => {
    const outbox = new PiCommandOutbox();
    const submit = outbox.submit("hello", "followUp");

    expect(submit).toMatchObject({
      type: "submit",
      input: "hello",
      whenBusy: "followUp"
    });
    expect(submit.operationId).toBe(submit.id);
    expect(outbox.pending()).toEqual([submit]);

    outbox.receive({ type: "result", id: "other", result: null });
    expect(outbox.pending()).toEqual([submit]);
    outbox.receive({ type: "result", id: submit.id, result: null });
    expect(outbox.pending()).toEqual([]);
  });

  it("drops a submit the server answered with an error", () => {
    const outbox = new PiCommandOutbox();
    const submit = outbox.submit("hello");
    outbox.receive({ type: "error", id: submit.id, message: "rejected" });
    expect(outbox.pending()).toEqual([]);
  });

  it("sends nothing on open with nothing pending", () => {
    const outbox = new PiCommandOutbox();
    const sent: string[] = [];
    outbox.sendPending((data) => sent.push(data));
    expect(sent).toEqual([]);

    const submit = outbox.submit("hello");
    outbox.receive({ type: "result", id: submit.id, result: null });
    outbox.sendPending((data) => sent.push(data));
    expect(sent).toEqual([]);
  });

  it("sends an unanswered submit again on reconnect without running it twice", async () => {
    const name = crypto.randomUUID();
    const outbox = new PiCommandOutbox();
    const submit = outbox.submit("echo once");

    // The server admits the prompt, but the socket drops before the client
    // reads the result.
    const first = await connect(name);
    await replay(first, outbox, submit.id);
    first.close();
    expect(outbox.pending()).toEqual([submit]);

    const second = await connect(name);
    const result = await replay(second, outbox, submit.id);
    outbox.receive(result);
    second.close();

    expect(result).toMatchObject({ result: { accepted: false } });
    expect(outbox.pending()).toEqual([]);
    const stub = env.PI_HARNESS_TEST.getByName(name);
    await stub.wait(submit.operationId);
    const view = JSON.parse(await stub.snapshotView()) as PiSessionView;
    const prompts = view.messages.filter(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) => part.type === "text" && part.text === "echo once"
        )
    );
    expect(prompts).toHaveLength(1);
  });
});
