import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ChannelGateway,
  matchesPath,
  type Channel,
  type ChannelInboundMessageInput
} from "../../experimental/channels";

/** A webhook Channel that turns a POST to /hook into one message. */
function hook(threadId: string): Channel {
  const event: ChannelInboundMessageInput = {
    type: "message",
    eventId: crypto.randomUUID(),
    thread: { id: threadId, isDirectMessage: true },
    replySurface: { version: 1, address: null, label: "Hook" },
    actor: { id: "actor-1" },
    message: { id: "message-1", text: "Hello", attachments: [] }
  };
  return {
    ingress: {
      receive: async (request) =>
        matchesPath(request, "/hook")
          ? { events: [{ event, raw: null }], response: new Response() }
          : null
    }
  };
}

function stub(name: string) {
  return env.ChannelsHarnessObject.getByName(name);
}

describe("ChannelGateway to the agent over RPC", () => {
  it("delivers a webhook event to the agent's receive method", async () => {
    const route = crypto.randomUUID();
    const gateway = new ChannelGateway({
      agent: stub,
      channels: { hook: hook(route) }
    });

    const response = await gateway.fetch(
      new Request("https://example.com/hook", { method: "POST" })
    );
    expect(response?.status).toBe(200);

    const [received] = await stub(route).getCalls();
    // The route named no conversation, so the harness's default session.
    expect(received).toMatchObject({
      type: "submit",
      session: "default",
      input: {
        parts: [{ type: "text", text: "Hello" }],
        from: { participantId: "hook:actor-1" }
      }
    });
  });

  it("refuses a conversation operation from a gateway surface", async () => {
    const route = crypto.randomUUID();
    expect(
      await stub(route).tryReceive(
        { type: "conversation-create", eventId: "e1" },
        {
          route,
          participant: { id: "U1" },
          surface: { channelKey: "hook", version: 1, address: null, label: "" }
        }
      )
    ).toBe("conversation-create is not supported on this surface");
    expect(await stub(route).getCalls()).toEqual([]);
  });

  it("leaves a request that is not for Channels to the Worker", async () => {
    const gateway = new ChannelGateway({ agent: stub, channels: {} });
    expect(
      await gateway.fetch(new Request("https://example.com/elsewhere"))
    ).toBeUndefined();
  });
});
