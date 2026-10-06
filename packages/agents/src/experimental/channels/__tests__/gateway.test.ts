import { describe, expect, it, vi } from "vitest";
import {
  ChannelGateway,
  matchesPath,
  type GatewayAgent,
  type Channel,
  type ChannelApprovalResponseInput,
  type ChannelEmailIngress,
  type ChannelEmailInput,
  type ChannelInboundMessageInput,
  type ChannelIngress,
  type ChannelIngressEnvelope,
  type ChannelIngressEvent,
  type ChannelRouteEvent
} from "..";
import { web } from "../web/ingress";
import { WEB_IDENTITY_HEADER } from "../web/protocol";

const delivered = async () => ({ status: "delivered" as const });
const surface = {
  channelKey: "test",
  version: 1,
  address: null,
  label: "Test destination"
} as const;
const replySurface = {
  version: 1,
  address: null,
  label: "Reply destination"
} as const;

function message(
  eventId = "event-1",
  threadId = "provider-thread-1"
): ChannelInboundMessageInput {
  return {
    type: "message",
    eventId,
    thread: {
      id: threadId,
      isDirectMessage: true
    },
    replySurface,
    actor: { id: "actor-1", username: "operator" },
    message: {
      id: "message-1",
      text: "Hello",
      attachments: []
    }
  };
}

function approval(eventId = "event-2"): ChannelApprovalResponseInput {
  return {
    type: "approval-response",
    eventId,
    thread: {
      id: "provider-thread-2",
      isDirectMessage: "unknown"
    },
    replySurface,
    actor: { id: "actor-2" },
    approvalId: "interaction-1",
    decision: "approve",
    reference: "approval-1"
  };
}

function httpIngress<TRaw>(
  path: string,
  events: readonly ChannelIngressEnvelope<TRaw>[],
  response = new Response("acknowledged", { status: 202 })
): ChannelIngress<TRaw> {
  return {
    receive: vi.fn(async (request) =>
      matchesPath(request, path) ? { events, response } : null
    )
  };
}

/** The app's participant callback in these tests: the provider's actor id. */
const byActor = (event: ChannelIngressEvent) => event.actor?.id ?? null;

function emailInput(): ChannelEmailInput {
  return {
    from: "operator@example.com",
    to: "agent@example.com",
    headers: new Headers()
  };
}

function fakeAgent(
  receive = vi.fn<GatewayAgent["receive"]>(async () => undefined)
): GatewayAgent {
  return { receive, fetch: vi.fn(async () => new Response()) };
}

function host(
  channels: Record<string, Channel>,
  overrides: Partial<ConstructorParameters<typeof ChannelGateway>[0]> = {}
) {
  return new ChannelGateway({
    channels,
    agent: () => fakeAgent(),
    ...overrides
  });
}

describe("stateless ChannelGateway", () => {
  it("an outbound-only gateway never reaches its agent", async () => {
    const deliver = vi.fn(delivered);
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = new ChannelGateway({
      channels: { outbound: { deliver } },
      agent: () => fakeAgent(receive)
    });
    const destination = { ...surface, channelKey: "outbound" };

    await expect(
      gateway.deliver(destination, { markdown: "Hello" })
    ).resolves.toEqual({ status: "delivered" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("accepts an inbound-only Channel without deliver", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = host(
      {
        inbound: {
          participant: byActor,
          ingress: httpIngress("/inbound", [{ event: message(), raw: null }])
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    await gateway.fetch(
      new Request("https://example.com/inbound", { method: "POST" })
    );

    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        eventId: expect.stringMatching(/^sha256:[\da-f]{64}$/),
        message: {
          id: expect.stringMatching(/^sha256:[\da-f]{64}$/),
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      }),
      expect.objectContaining({
        route: "participant:actor-1",
        participant: { id: "actor-1" },
        surface: expect.objectContaining({ channelKey: "inbound" })
      })
    );
  });

  it("tries HTTP ingresses in configuration order and uses the first non-null result", async () => {
    const declines = httpIngress("/other", []);
    const first = httpIngress("/webhook", []);
    const duplicate = httpIngress("/webhook", []);
    const gateway = host({
      declines: { deliver: delivered, participant: byActor, ingress: declines },
      first: { deliver: delivered, participant: byActor, ingress: first },
      duplicate: {
        deliver: delivered,
        participant: byActor,
        ingress: duplicate
      }
    });

    await expect(
      gateway.fetch(
        new Request("https://example.com/webhook", { method: "POST" })
      )
    ).resolves.toMatchObject({ status: 202 });

    expect(declines.receive).toHaveBeenCalledOnce();
    expect(first.receive).toHaveBeenCalledOnce();
    expect(duplicate.receive).not.toHaveBeenCalled();
  });

  it("returns undefined when every HTTP ingress declines an exact pathname", async () => {
    const ingress = httpIngress("/webhooks/telegram", []);
    const gateway = host({
      telegram: { deliver: delivered, participant: byActor, ingress }
    });

    await expect(
      gateway.fetch(
        new Request("https://example.com/anything/webhooks/telegram", {
          method: "POST"
        })
      )
    ).resolves.toBeUndefined();
    expect(ingress.receive).toHaveBeenCalledOnce();
  });

  it("does not fall through when an HTTP ingress claims and rejects a request", async () => {
    const rejection: ChannelIngress = {
      receive: vi.fn(async () => ({
        events: [],
        response: new Response(null, { status: 401 })
      }))
    };
    const later = httpIngress("/webhook", []);
    const gateway = host({
      rejection: {
        deliver: delivered,
        participant: byActor,
        ingress: rejection
      },
      later: { deliver: delivered, participant: byActor, ingress: later }
    });

    await expect(
      gateway.fetch(
        new Request("https://example.com/webhook", { method: "POST" })
      )
    ).resolves.toMatchObject({ status: 401 });
    expect(later.receive).not.toHaveBeenCalled();
  });

  it("passes the participant and the exact raw value only to routing", async () => {
    const raw = { authenticatedUpdate: 42 };
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const participant = vi.fn((_event, receivedRaw: typeof raw) => {
      expect(receivedRaw).toBe(raw);
      return { id: "user-1", name: "Operator" };
    });
    const route = vi.fn(
      (_event, receivedRaw: typeof raw, { id }: { id: string }) => {
        expect(receivedRaw).toBe(raw);
        return `team-of:${id}`;
      }
    );
    const channel: Channel<typeof raw> = {
      participant,
      route,
      deliver: delivered,
      ingress: httpIngress("/webhook", [{ event: message(), raw }])
    };
    const gateway = host(
      { webhook: channel, outputOnly: { deliver: delivered } },
      { agent: () => fakeAgent(receive) }
    );

    const response = await gateway.fetch(
      new Request("https://example.com/webhook", { method: "POST" })
    );

    expect(response?.status).toBe(202);
    expect(await response?.text()).toBe("acknowledged");
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0]?.[1]).toMatchObject({
      route: "team-of:user-1",
      participant: { id: "user-1", name: "Operator" }
    });
    expect(receive.mock.calls[0]?.[0]).not.toHaveProperty("raw");
  });

  it("routes each participant to an agent object of their own by default", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    // Two people in one provider thread reach two objects.
    const second: ChannelInboundMessageInput = {
      ...message("event-2"),
      actor: { id: "actor-2" }
    };
    const gateway = host(
      {
        inbound: {
          participant: byActor,
          ingress: httpIngress("/inbound", [
            { event: message(), raw: null },
            { event: second, raw: null }
          ])
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    await gateway.fetch(
      new Request("https://example.com/inbound", { method: "POST" })
    );

    expect(receive.mock.calls.map(([, origin]) => origin.route)).toEqual([
      "participant:actor-1",
      "participant:actor-2"
    ]);
  });

  it("drops an event whose sender the app refuses, and observes it", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const onRoute = vi.fn();
    const route = vi.fn(() => "never");
    const gateway = host(
      {
        inbound: {
          participant: () => null,
          route,
          ingress: httpIngress("/refused", [{ event: message(), raw: null }])
        }
      },
      { onRoute, agent: () => fakeAgent(receive) }
    );

    const response = await gateway.fetch(
      new Request("https://example.com/refused", { method: "POST" })
    );

    expect(response?.status).toBe(202);
    expect(route).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    expect(onRoute).toHaveBeenCalledWith(
      expect.objectContaining({ participant: null, route: null })
    );
  });

  it("turns an invalid participant into an HTTP 500", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = host(
      {
        inbound: {
          participant: () => ({ id: "" }),
          ingress: httpIngress("/invalid", [{ event: message(), raw: null }])
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    const response = await gateway.fetch(
      new Request("https://example.com/invalid", { method: "POST" })
    );

    expect(response?.status).toBe(500);
    expect(receive).not.toHaveBeenCalled();
  });

  it("refuses to start with ingress but no participant", () => {
    expect(() =>
      host({ inbound: { ingress: httpIngress("/inbound", []) } })
    ).toThrow('Channel "inbound" takes ingress but has no participant');
    expect(() =>
      host({ email: { emailIngress: { receive: async () => null } } })
    ).toThrow('Channel "email" takes ingress but has no participant');
  });

  it("awaits onRoute before dispatching an identical routed outcome", async () => {
    const event = message();
    let finishRoute: () => void = () => undefined;
    const routeFinished = new Promise<void>((resolve) => {
      finishRoute = resolve;
    });
    const onRoute = vi.fn(async (_event: ChannelRouteEvent) => routeFinished);
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = host(
      {
        inbound: {
          route() {
            return "application-route";
          },
          deliver: delivered,
          participant: byActor,
          ingress: httpIngress("/routed", [
            { event, raw: { authenticated: true } }
          ])
        }
      },
      { onRoute, agent: () => fakeAgent(receive) }
    );

    const handling = gateway.fetch(
      new Request("https://example.com/routed", { method: "POST" })
    );
    await vi.waitFor(() => expect(onRoute).toHaveBeenCalledOnce());
    expect(receive).not.toHaveBeenCalled();

    finishRoute();
    await handling;

    const routeEvent = onRoute.mock.calls[0]?.[0];
    const messageEvent = receive.mock.calls[0]?.[0];
    expect(routeEvent).toEqual({
      channelKey: "inbound",
      event: expect.objectContaining({
        eventId: event.eventId,
        replySurface: expect.objectContaining({ channelKey: "inbound" })
      }),
      participant: { id: "actor-1" },
      route: "application-route",
      dispatchId: expect.stringMatching(/^sha256:[\da-f]{64}$/)
    });
    expect(messageEvent).toEqual({
      type: "message",
      eventId: routeEvent?.dispatchId,
      message: {
        id: routeEvent?.dispatchId,
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    });
    expect(receive.mock.calls[0]?.[1].route).toBe(routeEvent?.route);
  });

  it("awaits and observes a null route without dispatching", async () => {
    const event = message();
    let finishRoute: () => void = () => undefined;
    const routeFinished = new Promise<void>((resolve) => {
      finishRoute = resolve;
    });
    const onRoute = vi.fn(async (_event: ChannelRouteEvent) => routeFinished);
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = host(
      {
        inbound: {
          route() {
            return null;
          },
          deliver: delivered,
          participant: byActor,
          ingress: httpIngress("/ignored", [{ event, raw: { ignored: true } }])
        }
      },
      { onRoute, agent: () => fakeAgent(receive) }
    );

    let responded = false;
    const handling = gateway
      .fetch(new Request("https://example.com/ignored", { method: "POST" }))
      .then((response) => {
        responded = true;
        return response;
      });
    await vi.waitFor(() => expect(onRoute).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    finishRoute();
    const response = await handling;

    expect(response?.status).toBe(202);
    expect(onRoute).toHaveBeenCalledWith({
      channelKey: "inbound",
      event: expect.objectContaining({
        eventId: event.eventId,
        replySurface: expect.objectContaining({ channelKey: "inbound" })
      }),
      participant: { id: "actor-1" },
      route: null,
      dispatchId: expect.stringMatching(/^sha256:[\da-f]{64}$/)
    });
    expect(onRoute.mock.calls[0]?.[0]).not.toHaveProperty("raw");
    expect(receive).not.toHaveBeenCalled();
  });

  it("turns an accidental undefined route into an HTTP 500", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = host(
      {
        inbound: {
          route() {
            return undefined as never;
          },
          deliver: delivered,
          participant: byActor,
          ingress: httpIngress("/invalid", [{ event: message(), raw: null }])
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    const response = await gateway.fetch(
      new Request("https://example.com/invalid", { method: "POST" })
    );

    expect(response?.status).toBe(500);
    expect(receive).not.toHaveBeenCalled();
  });

  it("keeps dispatch identity stable when application routing changes", async () => {
    let route = "first-route";
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const event = message("immutable-event");
    const gateway = host(
      {
        inbound: {
          route() {
            return route;
          },
          deliver: delivered,
          participant: byActor,
          ingress: httpIngress("/rerouted", [{ event, raw: null }])
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    await gateway.fetch(
      new Request("https://example.com/rerouted", { method: "POST" })
    );
    route = "second-route";
    await gateway.fetch(
      new Request("https://example.com/rerouted", { method: "POST" })
    );

    expect(receive.mock.calls.map(([, origin]) => origin.route)).toEqual([
      "first-route",
      "second-route"
    ]);
    expect(receive.mock.calls[0]?.[0].eventId).toBe(
      receive.mock.calls[1]?.[0].eventId
    );
  });

  it("tries Email ingresses in configuration order and uses the first non-null result", async () => {
    const declines: ChannelEmailIngress = {
      receive: vi.fn(async () => null)
    };
    const first: ChannelEmailIngress = {
      receive: vi.fn(async () => ({ events: [] }))
    };
    const later: ChannelEmailIngress = {
      receive: vi.fn(async () => ({ events: [] }))
    };
    const gateway = host({
      declines: {
        deliver: delivered,
        participant: byActor,
        emailIngress: declines
      },
      first: { deliver: delivered, participant: byActor, emailIngress: first },
      later: { deliver: delivered, participant: byActor, emailIngress: later }
    });

    await expect(gateway.handleEmail(emailInput())).resolves.toBe(true);
    expect(declines.receive).toHaveBeenCalledOnce();
    expect(first.receive).toHaveBeenCalledOnce();
    expect(later.receive).not.toHaveBeenCalled();

    const allDecline = host({
      first: {
        deliver: delivered,
        participant: byActor,
        emailIngress: declines
      },
      outputOnly: { deliver: delivered }
    });
    await expect(allDecline.handleEmail(emailInput())).resolves.toBe(false);
  });

  it("dispatches HTTP messages and Email approvals through the agent", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const emailRaw = { authenticatedEmail: true };
    const emailIngress: ChannelEmailIngress<typeof emailRaw> = {
      receive: vi.fn(async () => ({
        events: [{ event: approval(), raw: emailRaw }]
      }))
    };
    const emailRoute = vi.fn((_event, raw: typeof emailRaw) => {
      expect(raw).toBe(emailRaw);
      return "approval-route";
    });
    const gateway = host(
      {
        http: {
          deliver: delivered,
          participant: byActor,
          ingress: httpIngress("/message", [
            { event: message(), raw: { update: 1 } }
          ])
        },
        email: {
          route: emailRoute,
          deliver: delivered,
          participant: byActor,
          emailIngress
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    await gateway.fetch(
      new Request("https://example.com/message", { method: "POST" })
    );
    await expect(gateway.handleEmail(emailInput())).resolves.toBe(true);

    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[0]?.[0]).toMatchObject({
      type: "message",
      message: {
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    });
    expect(receive.mock.calls[0]?.[1]).toMatchObject({
      route: "participant:actor-1",
      participant: { id: "actor-1" },
      surface: { channelKey: "http" }
    });
    expect(receive.mock.calls[1]?.[0]).toMatchObject({
      type: "approval-response",
      approvalId: "interaction-1",
      approved: true
    });
    expect(receive.mock.calls[1]?.[1]).toMatchObject({
      route: "approval-route",
      participant: { id: "actor-2" },
      surface: { channelKey: "email" }
    });
    expect(receive.mock.calls[1]?.[0]).not.toHaveProperty("raw");
  });

  it("stamps inbound reply surfaces with the configured Channel key", async () => {
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const route = vi.fn(() => "support-route");
    const event = {
      ...message(),
      replySurface: {
        version: 1,
        address: { destination: "thread-1" },
        label: "Support thread"
      }
    } as const;
    const gateway = host(
      {
        support: {
          route,
          participant: byActor,
          ingress: httpIngress("/support", [{ event, raw: null }])
        }
      },
      { agent: () => fakeAgent(receive) }
    );

    await gateway.fetch(
      new Request("https://example.com/support", { method: "POST" })
    );

    expect(route.mock.calls[0]?.[0].replySurface).toEqual({
      channelKey: "support",
      version: 1,
      address: { destination: "thread-1" },
      label: "Support thread"
    });
    expect(receive.mock.calls[0]?.[1].surface).toEqual({
      channelKey: "support",
      version: 1,
      address: { destination: "thread-1" },
      label: "Support thread"
    });
  });

  it("resolves direct delivery through the surface key", async () => {
    const deliver = vi.fn(delivered);
    const gateway = host({ outbound: { deliver } });
    const destination = { ...surface, channelKey: "outbound" };
    const message = { markdown: "Hello" };

    await expect(gateway.deliver(destination, message)).resolves.toEqual({
      status: "delivered"
    });
    expect(deliver).toHaveBeenCalledWith(destination, message, undefined);
  });

  it("rejects malformed outbound surfaces before a custom Channel sees them", async () => {
    const deliver = vi.fn(delivered);
    const stream = vi.fn(delivered);
    const gateway = host({ outbound: { deliver, stream } });
    const malformed = {
      ...surface,
      channelKey: "outbound",
      label: " "
    };
    const cancel = vi.fn();
    const chunks = new ReadableStream({ cancel });

    await expect(
      gateway.deliver(malformed, { markdown: "Hello" })
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "CHANNEL_SURFACE_INVALID" }
    });
    await expect(gateway.stream(malformed, chunks)).resolves.toMatchObject({
      status: "failed",
      error: { code: "CHANNEL_SURFACE_INVALID" }
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("resolves a contact surface directly through the identity Channel key", () => {
    const first = vi.fn(() => {
      throw new Error("must not inspect a different configured Channel");
    });
    const second = vi.fn(() => ({
      version: 1 as const,
      address: { userId: "actor-1" },
      label: "Test user actor-1"
    }));
    const identity = {
      channelKey: "second",
      subject: "actor-1"
    } as const;
    const gateway = host({
      first: { contactSurface: first },
      second: { contactSurface: second }
    });

    expect(gateway.contactSurface(identity)).toEqual({
      channelKey: "second",
      version: 1,
      address: { userId: "actor-1" },
      label: "Test user actor-1"
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(identity);
  });

  it("fails loudly when a surface names an unknown configured Channel", async () => {
    const gateway = host({});

    await expect(
      gateway.deliver(
        { ...surface, channelKey: "renamed-or-missing" },
        { markdown: "Hello" }
      )
    ).rejects.toThrow(
      'Channel message surface names unknown configured Channel key "renamed-or-missing"'
    );
  });

  it("returns HTTP 500 but throws Email agent failures", async () => {
    const failure = new Error("durable handoff failed");
    const receive = vi.fn<GatewayAgent["receive"]>(async () => {
      throw failure;
    });
    const emailIngress: ChannelEmailIngress<null> = {
      receive: vi.fn(async () => ({
        events: [{ event: message(), raw: null }]
      }))
    };
    const gateway = host(
      {
        http: {
          deliver: delivered,
          participant: byActor,
          ingress: httpIngress("/failing", [{ event: message(), raw: null }])
        },
        email: { deliver: delivered, participant: byActor, emailIngress }
      },
      { agent: () => fakeAgent(receive) }
    );

    const response = await gateway.fetch(
      new Request("https://example.com/failing", { method: "POST" })
    );

    expect(response?.status).toBe(500);
    await expect(gateway.handleEmail(emailInput())).rejects.toThrow(
      "durable handoff failed"
    );
  });
});

describe("ChannelGateway Web upgrades", () => {
  function upgrade(path: string, headers: Record<string, string> = {}) {
    return new Request(`https://example.com${path}`, {
      headers: { Upgrade: "websocket", ...headers }
    });
  }

  function gatewayWith(options: Parameters<typeof web>[0]) {
    const fetch = vi.fn<GatewayAgent["fetch"]>(async () => new Response());
    const agent = vi.fn(() => ({ receive: vi.fn(), fetch }));
    const gateway = new ChannelGateway({
      channels: { web: web(options) },
      agent
    });
    const forwarded = () => {
      const header = fetch.mock.calls[0]?.[0].headers.get(WEB_IDENTITY_HEADER);
      return header ? JSON.parse(header) : undefined;
    };
    return { gateway, agent, fetch, forwarded };
  }

  it("forwards an upgrade to the participant's own agent object by default", async () => {
    const { gateway, agent, forwarded } = gatewayWith({
      participant: () => ({ id: "user-1", name: "Ada" })
    });

    await gateway.fetch(upgrade("/channels"));

    expect(agent).toHaveBeenCalledWith("participant:user-1");
    expect(forwarded()).toEqual({
      route: "participant:user-1",
      participant: { id: "user-1", name: "Ada" }
    });
  });

  it("follows the conversation the path names, and accepts a plain id", async () => {
    const { gateway, forwarded } = gatewayWith({
      participant: () => "anonymous"
    });

    await gateway.fetch(upgrade("/channels/conversation%201"));

    expect(forwarded()).toEqual({
      route: "participant:anonymous",
      conversationId: "conversation 1",
      participant: { id: "anonymous" }
    });
  });

  it("replaces an identity header the client sent", async () => {
    const { gateway, forwarded } = gatewayWith({ participant: () => "user-1" });

    await gateway.fetch(
      upgrade("/channels", {
        [WEB_IDENTITY_HEADER]: JSON.stringify({
          route: "someone-else",
          participant: { id: "admin" }
        })
      })
    );

    expect(forwarded()).toMatchObject({ participant: { id: "user-1" } });
  });

  it("refuses an unauthenticated upgrade before routing it", async () => {
    const route = vi.fn(() => "room");
    const { gateway, fetch } = gatewayWith({ participant: () => null, route });

    const response = await gateway.fetch(upgrade("/channels"));

    expect(response?.status).toBe(401);
    expect(route).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets the app route a participant to a shared object, or refuse them", async () => {
    const { gateway, agent, fetch } = gatewayWith({
      participant: (request) => request.headers.get("x-user"),
      route: (request, participant) => {
        const room = new URL(request.url).searchParams.get("room");
        return room === "team" && participant.id === "member" ? "team" : null;
      }
    });

    const member = await gateway.fetch(
      upgrade("/channels?room=team", { "x-user": "member" })
    );
    const outsider = await gateway.fetch(
      upgrade("/channels?room=team", { "x-user": "outsider" })
    );

    expect(member?.status).toBe(200);
    expect(agent).toHaveBeenCalledWith("team");
    expect(outsider?.status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("leaves an upgrade no Channel matches to the Worker", async () => {
    const participant = vi.fn(() => "user-1");
    const { gateway } = gatewayWith({
      participant,
      match: (request) =>
        new URL(request.url).pathname === "/chat" ? {} : undefined
    });

    expect(await gateway.fetch(upgrade("/channels"))).toBeUndefined();
    expect(participant).not.toHaveBeenCalled();
    expect(
      await new ChannelGateway({
        channels: {},
        agent: () => fakeAgent()
      }).fetch(upgrade("/channels"))
    ).toBeUndefined();
  });
});
