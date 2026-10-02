import { describe, expect, it, vi } from "vitest";
import {
  ChannelGateway,
  matchesPath,
  type GatewayAgent,
  type Channel,
  type ChannelApprovalResponseInput,
  type ChannelEmailIngress,
  type ChannelEmailInput,
  type ChannelIdentityInput,
  type ChannelInboundMessageInput,
  type ChannelIngress,
  type ChannelIngressEnvelope,
  type ChannelRouteContext,
  type ChannelRouteEvent
} from "..";

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
        route: "provider-thread-1",
        participant: { id: "inbound:actor-1", name: "operator" },
        surface: expect.objectContaining({ channelKey: "inbound" })
      })
    );
  });

  it("tries HTTP ingresses in configuration order and uses the first non-null result", async () => {
    const declines = httpIngress("/other", []);
    const first = httpIngress("/webhook", []);
    const duplicate = httpIngress("/webhook", []);
    const gateway = host({
      declines: { deliver: delivered, ingress: declines },
      first: { deliver: delivered, ingress: first },
      duplicate: { deliver: delivered, ingress: duplicate }
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
      telegram: { deliver: delivered, ingress }
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
      rejection: { deliver: delivered, ingress: rejection },
      later: { deliver: delivered, ingress: later }
    });

    await expect(
      gateway.fetch(
        new Request("https://example.com/webhook", { method: "POST" })
      )
    ).resolves.toMatchObject({ status: 401 });
    expect(later.receive).not.toHaveBeenCalled();
  });

  it("uses Channel route before Host default route and passes the exact raw value only to routing", async () => {
    const raw = { authenticatedUpdate: 42 };
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const defaultRoute = vi.fn(() => "host-default");
    const route = vi.fn((_event, receivedRaw: typeof raw) => {
      expect(receivedRaw).toBe(raw);
      return "channel-route";
    });
    const channel: Channel<typeof raw> = {
      route,
      deliver: delivered,
      ingress: httpIngress("/webhook", [{ event: message(), raw }])
    };
    const channels: Record<string, Channel> = {
      webhook: channel,
      outputOnly: { deliver: delivered }
    };
    const findUser = vi.fn();
    const gateway = host(channels, {
      defaultRoute,
      findUser,
      agent: () => fakeAgent(receive)
    });

    const response = await gateway.fetch(
      new Request("https://example.com/webhook", { method: "POST" })
    );

    expect(response?.status).toBe(202);
    expect(await response?.text()).toBe("acknowledged");
    expect(defaultRoute).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0]?.[1]).toMatchObject({
      route: "channel-route"
    });
    expect(receive.mock.calls[0]?.[0]).not.toHaveProperty("raw");
  });

  it("uses the Host default route before falling back to the provider thread id", async () => {
    const event = message();
    const defaultMessage = vi.fn<GatewayAgent["receive"]>(
      async () => undefined
    );
    const threadMessage = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const withDefault = host(
      {
        inbound: {
          deliver: delivered,
          ingress: httpIngress("/default", [{ event, raw: null }])
        }
      },
      {
        defaultRoute: () => "host-default",
        agent: () => fakeAgent(defaultMessage)
      }
    );
    const withThreadFallback = host(
      {
        inbound: {
          deliver: delivered,
          ingress: httpIngress("/thread", [{ event, raw: null }])
        }
      },
      { agent: () => fakeAgent(threadMessage) }
    );

    await withDefault.fetch(
      new Request("https://example.com/default", { method: "POST" })
    );
    await withThreadFallback.fetch(
      new Request("https://example.com/thread", { method: "POST" })
    );

    expect(defaultMessage.mock.calls[0]?.[1].route).toBe("host-default");
    expect(threadMessage.mock.calls[0]?.[1].route).toBe("provider-thread-1");
  });

  it("stamps an identity before lazily resolving and memoizing its user", async () => {
    const identity = {
      subject: "actor-1"
    } satisfies ChannelIdentityInput;
    const stampedIdentity = {
      channelKey: "inbound",
      ...identity
    } as const;
    const event: ChannelInboundMessageInput = {
      ...message(),
      actor: { id: "actor-1", identity }
    };
    const user = { id: "user-1", channelIdentities: [stampedIdentity] };
    const findUser = vi.fn(async () => user);
    const route = vi.fn(
      async (_event: unknown, _raw: unknown, context: ChannelRouteContext) => {
        const first = await context.findUser();
        const second = await context.findUser();
        expect(second).toBe(first);
        return first ? `user:${first.id}` : null;
      }
    );
    const receive = vi.fn<GatewayAgent["receive"]>(async () => undefined);
    const gateway = host(
      {
        inbound: {
          route,
          deliver: delivered,
          ingress: httpIngress("/identity", [{ event, raw: null }])
        }
      },
      { findUser, agent: () => fakeAgent(receive) }
    );

    await gateway.fetch(
      new Request("https://example.com/identity", { method: "POST" })
    );

    expect(findUser).toHaveBeenCalledOnce();
    expect(findUser).toHaveBeenCalledWith(stampedIdentity);
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message" }),
      expect.objectContaining({
        route: "user:user-1",
        participant: {
          id: JSON.stringify(["inbound", "default", "actor-1"])
        }
      })
    );
  });

  it("returns null from route context without a lookup or actor identity", async () => {
    const findUser = vi.fn();
    const withoutIdentity = vi.fn(
      async (_event: unknown, _raw: unknown, context: ChannelRouteContext) => {
        expect(await context.findUser()).toBeNull();
        return "without-identity";
      }
    );
    const withoutLookup = vi.fn(
      async (_event: unknown, _raw: unknown, context: ChannelRouteContext) => {
        expect(await context.findUser()).toBeNull();
        return "without-lookup";
      }
    );
    const withIdentity: ChannelInboundMessageInput = {
      ...message("event-with-identity"),
      actor: {
        id: "actor-1",
        identity: { subject: "actor-1" }
      }
    };

    await host(
      {
        inbound: {
          route: withoutIdentity,
          deliver: delivered,
          ingress: httpIngress("/without-identity", [
            { event: message(), raw: null }
          ])
        }
      },
      { findUser }
    ).fetch(
      new Request("https://example.com/without-identity", { method: "POST" })
    );
    await host({
      inbound: {
        route: withoutLookup,
        deliver: delivered,
        ingress: httpIngress("/without-lookup", [
          { event: withIdentity, raw: null }
        ])
      }
    }).fetch(
      new Request("https://example.com/without-lookup", { method: "POST" })
    );

    expect(findUser).not.toHaveBeenCalled();
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
    const defaultRoute = vi.fn(() => "host-default");
    const gateway = host(
      {
        inbound: {
          route() {
            return null;
          },
          deliver: delivered,
          ingress: httpIngress("/ignored", [{ event, raw: { ignored: true } }])
        }
      },
      { defaultRoute, onRoute, agent: () => fakeAgent(receive) }
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
      route: null,
      dispatchId: expect.stringMatching(/^sha256:[\da-f]{64}$/)
    });
    expect(onRoute.mock.calls[0]?.[0]).not.toHaveProperty("raw");
    expect(defaultRoute).not.toHaveBeenCalled();
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
          ingress: httpIngress("/invalid", [{ event: message(), raw: null }])
        }
      },
      { defaultRoute: () => "host-default", agent: () => fakeAgent(receive) }
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
      declines: { deliver: delivered, emailIngress: declines },
      first: { deliver: delivered, emailIngress: first },
      later: { deliver: delivered, emailIngress: later }
    });

    await expect(gateway.handleEmail(emailInput())).resolves.toBe(true);
    expect(declines.receive).toHaveBeenCalledOnce();
    expect(first.receive).toHaveBeenCalledOnce();
    expect(later.receive).not.toHaveBeenCalled();

    const allDecline = host({
      first: { deliver: delivered, emailIngress: declines },
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
          ingress: httpIngress("/message", [
            { event: message(), raw: { update: 1 } }
          ])
        },
        email: {
          route: emailRoute,
          deliver: delivered,
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
      route: "provider-thread-1",
      participant: { id: "http:actor-1", name: "operator" },
      surface: { channelKey: "http" }
    });
    expect(receive.mock.calls[1]?.[0]).toMatchObject({
      type: "approval-response",
      approvalId: "interaction-1",
      approved: true
    });
    expect(receive.mock.calls[1]?.[1]).toMatchObject({
      route: "approval-route",
      participant: { id: "email:actor-2" },
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
          ingress: httpIngress("/failing", [{ event: message(), raw: null }])
        },
        email: { deliver: delivered, emailIngress }
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
