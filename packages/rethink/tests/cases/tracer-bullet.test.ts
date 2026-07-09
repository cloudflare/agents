import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../../src";
import { getDurableObjectStub } from "../helpers/durable-object";
import { listSentEmails } from "../helpers/email";
import { waitForFrames } from "../helpers/websocket";

describe("TracerBulletDurableObject", () => {
  it("composes WebSocket and Email channels on one PrimitiveHost", async () => {
    const stub = getDurableObjectStub(env.TRACER_BULLET_DO, "tracer-test");

    const response = await stub.fetch(
      new Request("https://example.com/ws", {
        headers: { Upgrade: "websocket" }
      })
    );

    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("Expected WebSocket upgrade response");
    ws.accept();

    const frames = waitForFrames(ws, 2);
    ws.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "req-1",
        init: { body: "hello over ws" }
      })
    );

    const [chunkFrame, doneFrame] = await frames;
    expect(chunkFrame).toEqual({
      type: "cf_agent_use_chat_response",
      id: "req-1",
      body: JSON.stringify({
        type: "text-delta",
        id: "rethink-tracer",
        delta: "websocket: hello over ws"
      }),
      done: false
    });
    expect(doneFrame).toEqual({
      type: "cf_agent_use_chat_response",
      id: "req-1",
      body: "",
      done: true
    });

    const claimed = await stub.deliverEmail({
      from: "user@example.com",
      to: "agent@example.com",
      subject: "question",
      body: "hello over email",
      messageId: "email-1"
    } satisfies InboundEmail);

    expect(claimed).toBe(true);
    const sent = await listSentEmails(env.SENT_EMAILS);
    expect(sent).toEqual([
      {
        from: "agent@example.com",
        to: "user@example.com",
        subject: "re: question",
        body: "email: hello over email",
        headers: { "In-Reply-To": "email-1" }
      }
    ]);
  });
});
