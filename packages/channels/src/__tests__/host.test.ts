import { describe, expect, it, vi } from "vitest";
import {
  ChannelHost,
  matchesPath,
  type Channel,
  type ChannelApprovalResponse,
  type ChannelEmailIngress,
  type ChannelEmailInput,
  type ChannelIdentityInput,
  type ChannelInboundMessage,
  type ChannelInboundMessageInput,
  type ChannelIngress,
  type ChannelIngressEnvelope,
  type ChannelRouteContext,
  type ChannelRouteEvent
} from "..";
import { bindChannelIngress, type BindableChannelIngress } from "../internal";

const delivered = async () => ({ status: "delivered" as const });
const surface = {
  channelKey: "test",
  version: 1,
  address: null,
  label: "Test destination"
} as const;

function message(
  eventId = "event-1",
  threadId = "provider-thread-1"
): ChannelInboundMessage {
  return {
    type: "message",
    eventId,
    thread: {
      id: threadId,
      isDirectMessage: true
    },
    actor: { id: "actor-1", username: "operator" },
    message: {
      id: "message-1",
      text: "Hello",
      attachments: []
    }
  };
}

function approval(eventId = "event-2"): ChannelApprovalResponse {
  return {
    type: "approval-response",
    eventId,
    thread: {
      id: "provider-thread-2",
      isDirectMessage: "unknown"
    },
    actor: { id: "actor-2" },
    interactionId: "interaction-1",
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

function host(
  channels: Record<string, Channel>,
  overrides: Partial<ConstructorParameters<typeof ChannelHost>[0]> = {}
) {
  return new ChannelHost({
    channels,
    onMessage: vi.fn(),
    ...overrides
  });
}

describe("stateless ChannelHost", () => {
  it("routes push-based Channel ingress through onMessage", async () => {
    let push:
      | ((
          envelope: ChannelIngressEnvelope<{ requestId: string }>
        ) => Promise<void>)
      | undefined;
    const channel: Channel<{ requestId: string }> &
      BindableChannelIngress<{ requestId: string }> = {
      [bindChannelIngress](dispatch) {
        push = dispatch;
      },
      route: vi.fn((_event, raw) => `request:${raw.requestId}`)
    };
    const onMessage = vi.fn();
    host({ web: channel }, { onMessage });

    await push?.({
      event: message(),
      raw: { requestId: "turn-1" }
    });

    expect(channel.route).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "event-1" }),
      { requestId: "turn-1" },
      expect.objectContaining({ findUser: expect.any(Function) })
    );
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "web",
        route: "request:turn-1",
        message: expect.objectContaining({ type: "message" })
      })
    );
  });

  it("allows an outbound-only Host without ingress callbacks", async () => {
    const deliver = vi.fn(delivered);
    const channelHost = new ChannelHost({
      channels: { outbound: { deliver } }
    });
    const destination = { ...surface, channelKey: "outbound" };

    await expect(
      channelHost.deliver(destination, { markdown: "Hello" })
    ).resolves.toEqual({ status: "delivered" });
  });

  it("accepts an inbound-only Channel without deliver", async () => {
    const onMessage = vi.fn();
    const channelHost = host(
      {
        inbound: {
          ingress: httpIngress("/inbound", [{ event: message(), raw: null }])
        }
      },
      { onMessage }
    );

    await channelHost.handleRequest(
      new Request("https://example.com/inbound", { method: "POST" })
    );

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ route: "provider-thread-1" })
    );
  });

  it("tries HTTP ingresses in configuration order and uses the first non-null result", async () => {
    const declines = httpIngress("/other", []);
    const first = httpIngress("/webhook", []);
    const duplicate = httpIngress("/webhook", []);
    const channelHost = host({
      declines: { deliver: delivered, ingress: declines },
      first: { deliver: delivered, ingress: first },
      duplicate: { deliver: delivered, ingress: duplicate }
    });

    await expect(
      channelHost.handleRequest(
        new Request("https://example.com/webhook", { method: "POST" })
      )
    ).resolves.toMatchObject({ status: 202 });

    expect(declines.receive).toHaveBeenCalledOnce();
    expect(first.receive).toHaveBeenCalledOnce();
    expect(duplicate.receive).not.toHaveBeenCalled();
  });

  it("returns undefined when every HTTP ingress declines an exact pathname", async () => {
    const ingress = httpIngress("/webhooks/telegram", []);
    const channelHost = host({
      telegram: { deliver: delivered, ingress }
    });

    await expect(
      channelHost.handleRequest(
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
    const channelHost = host({
      rejection: { deliver: delivered, ingress: rejection },
      later: { deliver: delivered, ingress: later }
    });

    await expect(
      channelHost.handleRequest(
        new Request("https://example.com/webhook", { method: "POST" })
      )
    ).resolves.toMatchObject({ status: 401 });
    expect(later.receive).not.toHaveBeenCalled();
  });

  it("uses Channel route before Host default route and passes the exact raw value only to routing", async () => {
    const raw = { authenticatedUpdate: 42 };
    const onMessage = vi.fn();
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
    const channelHost = host(channels, {
      defaultRoute,
      findUser,
      onMessage
    });

    const response = await channelHost.handleRequest(
      new Request("https://example.com/webhook", { method: "POST" })
    );

    expect(response?.status).toBe(202);
    expect(await response?.text()).toBe("acknowledged");
    expect(defaultRoute).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelKey: "webhook", route: "channel-route" })
    );
    expect(onMessage.mock.calls[0]?.[0]).not.toHaveProperty("raw");
  });

  it("uses the Host default route before falling back to the provider thread id", async () => {
    const event = message();
    const defaultMessage = vi.fn();
    const threadMessage = vi.fn();
    const withDefault = host(
      {
        inbound: {
          deliver: delivered,
          ingress: httpIngress("/default", [{ event, raw: null }])
        }
      },
      { defaultRoute: () => "host-default", onMessage: defaultMessage }
    );
    const withThreadFallback = host(
      {
        inbound: {
          deliver: delivered,
          ingress: httpIngress("/thread", [{ event, raw: null }])
        }
      },
      { onMessage: threadMessage }
    );

    await withDefault.handleRequest(
      new Request("https://example.com/default", { method: "POST" })
    );
    await withThreadFallback.handleRequest(
      new Request("https://example.com/thread", { method: "POST" })
    );

    expect(defaultMessage).toHaveBeenCalledWith(
      expect.objectContaining({ route: "host-default" })
    );
    expect(threadMessage).toHaveBeenCalledWith(
      expect.objectContaining({ route: "provider-thread-1" })
    );
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
    const onMessage = vi.fn();
    const channelHost = host(
      {
        inbound: {
          route,
          deliver: delivered,
          ingress: httpIngress("/identity", [{ event, raw: null }])
        }
      },
      { findUser, onMessage }
    );

    await channelHost.handleRequest(
      new Request("https://example.com/identity", { method: "POST" })
    );

    expect(findUser).toHaveBeenCalledOnce();
    expect(findUser).toHaveBeenCalledWith(stampedIdentity);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "user:user-1",
        message: expect.objectContaining({
          actor: expect.objectContaining({ identity: stampedIdentity })
        })
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
    ).handleRequest(
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
    }).handleRequest(
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
    const onMessage = vi.fn();
    const channelHost = host(
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
      { onRoute, onMessage }
    );

    const handling = channelHost.handleRequest(
      new Request("https://example.com/routed", { method: "POST" })
    );
    await vi.waitFor(() => expect(onRoute).toHaveBeenCalledOnce());
    expect(onMessage).not.toHaveBeenCalled();

    finishRoute();
    await handling;

    const routeEvent = onRoute.mock.calls[0]?.[0];
    const messageEvent = onMessage.mock.calls[0]?.[0];
    expect(routeEvent).toEqual({
      channelKey: "inbound",
      event,
      route: "application-route",
      dispatchId: expect.stringMatching(/^sha256:[\da-f]{64}$/)
    });
    expect(messageEvent).toMatchObject({
      channelKey: routeEvent?.channelKey,
      route: routeEvent?.route,
      dispatchId: routeEvent?.dispatchId,
      message: event
    });
  });

  it("awaits and observes a null route without dispatching", async () => {
    const event = message();
    let finishRoute: () => void = () => undefined;
    const routeFinished = new Promise<void>((resolve) => {
      finishRoute = resolve;
    });
    const onRoute = vi.fn(async (_event: ChannelRouteEvent) => routeFinished);
    const onMessage = vi.fn();
    const defaultRoute = vi.fn(() => "host-default");
    const channelHost = host(
      {
        inbound: {
          route() {
            return null;
          },
          deliver: delivered,
          ingress: httpIngress("/ignored", [{ event, raw: { ignored: true } }])
        }
      },
      { defaultRoute, onRoute, onMessage }
    );

    let responded = false;
    const handling = channelHost
      .handleRequest(
        new Request("https://example.com/ignored", { method: "POST" })
      )
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
      event,
      route: null,
      dispatchId: expect.stringMatching(/^sha256:[\da-f]{64}$/)
    });
    expect(onRoute.mock.calls[0]?.[0]).not.toHaveProperty("raw");
    expect(defaultRoute).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("turns an accidental undefined route into an HTTP 500", async () => {
    const onMessage = vi.fn();
    const channelHost = host(
      {
        inbound: {
          route() {
            return undefined as never;
          },
          deliver: delivered,
          ingress: httpIngress("/invalid", [{ event: message(), raw: null }])
        }
      },
      { defaultRoute: () => "host-default", onMessage }
    );

    const response = await channelHost.handleRequest(
      new Request("https://example.com/invalid", { method: "POST" })
    );

    expect(response?.status).toBe(500);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("keeps dispatch identity stable when application routing changes", async () => {
    let route = "first-route";
    const onMessage = vi.fn();
    const event = message("immutable-event");
    const channelHost = host(
      {
        inbound: {
          route() {
            return route;
          },
          deliver: delivered,
          ingress: httpIngress("/rerouted", [{ event, raw: null }])
        }
      },
      { onMessage }
    );

    await channelHost.handleRequest(
      new Request("https://example.com/rerouted", { method: "POST" })
    );
    route = "second-route";
    await channelHost.handleRequest(
      new Request("https://example.com/rerouted", { method: "POST" })
    );

    expect(onMessage.mock.calls.map(([value]) => value.route)).toEqual([
      "first-route",
      "second-route"
    ]);
    expect(onMessage.mock.calls[0]?.[0].dispatchId).toBe(
      onMessage.mock.calls[1]?.[0].dispatchId
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
    const channelHost = host({
      declines: { deliver: delivered, emailIngress: declines },
      first: { deliver: delivered, emailIngress: first },
      later: { deliver: delivered, emailIngress: later }
    });

    await expect(channelHost.handleEmail(emailInput())).resolves.toBe(true);
    expect(declines.receive).toHaveBeenCalledOnce();
    expect(first.receive).toHaveBeenCalledOnce();
    expect(later.receive).not.toHaveBeenCalled();

    const allDecline = host({
      first: { deliver: delivered, emailIngress: declines },
      outputOnly: { deliver: delivered }
    });
    await expect(allDecline.handleEmail(emailInput())).resolves.toBe(false);
  });

  it("dispatches HTTP messages and Email approval responses through one callback shape", async () => {
    const onMessage = vi.fn();
    const onApprovalResponse = vi.fn();
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
    const channelHost = host(
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
      { onMessage, onApprovalResponse }
    );

    await channelHost.handleRequest(
      new Request("https://example.com/message", { method: "POST" })
    );
    await expect(channelHost.handleEmail(emailInput())).resolves.toBe(true);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "http",
        route: "provider-thread-1",
        message: expect.objectContaining({ type: "message" })
      })
    );
    expect(onApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "email",
        route: "approval-route",
        response: expect.objectContaining({
          type: "approval-response",
          interactionId: "interaction-1"
        })
      })
    );
    expect(onApprovalResponse.mock.calls[0]?.[0]).not.toHaveProperty("raw");
  });

  it("stamps inbound reply surfaces with the configured Channel key", async () => {
    const onMessage = vi.fn();
    const route = vi.fn(() => "support-route");
    const event = {
      ...message(),
      replySurface: {
        version: 1,
        address: { destination: "thread-1" },
        label: "Support thread"
      }
    } as const;
    const channelHost = host(
      {
        support: {
          route,
          ingress: httpIngress("/support", [{ event, raw: null }])
        }
      },
      { onMessage }
    );

    await channelHost.handleRequest(
      new Request("https://example.com/support", { method: "POST" })
    );

    expect(route.mock.calls[0]?.[0].replySurface).toEqual({
      channelKey: "support",
      version: 1,
      address: { destination: "thread-1" },
      label: "Support thread"
    });
    expect(onMessage.mock.calls[0]?.[0].message.replySurface).toEqual({
      channelKey: "support",
      version: 1,
      address: { destination: "thread-1" },
      label: "Support thread"
    });
  });

  it("resolves direct and approval delivery through the surface key", async () => {
    const deliver = vi.fn(delivered);
    const requestApproval = vi.fn(delivered);
    const channelHost = host({ outbound: { deliver, requestApproval } });
    const destination = { ...surface, channelKey: "outbound" };
    const message = { markdown: "Hello" };
    const approval = {
      interactionId: "approval-1",
      request: { summary: "Proceed?", input: {} }
    };

    await expect(channelHost.deliver(destination, message)).resolves.toEqual({
      status: "delivered"
    });
    await expect(
      channelHost.requestApproval(destination, approval)
    ).resolves.toEqual({ status: "delivered" });
    expect(deliver).toHaveBeenCalledWith(destination, message, undefined);
    expect(requestApproval).toHaveBeenCalledWith(destination, approval);
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
    const channelHost = host({
      first: { contactSurface: first },
      second: { contactSurface: second }
    });

    expect(channelHost.contactSurface(identity)).toEqual({
      channelKey: "second",
      version: 1,
      address: { userId: "actor-1" },
      label: "Test user actor-1"
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(identity);
  });

  it.each(["fallback", "fanout"])(
    "rejects the reserved %s Channel key",
    (channelKey) => {
      expect(() => host({ [channelKey]: {} })).toThrow(
        `Channel key "${channelKey}" is reserved for a delivery policy`
      );
    }
  );

  it("fails loudly when a surface names an unknown configured Channel", async () => {
    const channelHost = host({});

    await expect(
      channelHost.deliver(
        { ...surface, channelKey: "renamed-or-missing" },
        { markdown: "Hello" }
      )
    ).rejects.toThrow(
      'Channel message surface names unknown configured Channel key "renamed-or-missing"'
    );
  });

  it("returns HTTP 500 but throws Email callback failures", async () => {
    const failure = new Error("durable handoff failed");
    const onMessage = vi.fn(async () => {
      throw failure;
    });
    const emailIngress: ChannelEmailIngress<null> = {
      receive: vi.fn(async () => ({
        events: [{ event: message(), raw: null }]
      }))
    };
    const channelHost = host(
      {
        http: {
          deliver: delivered,
          ingress: httpIngress("/failing", [{ event: message(), raw: null }])
        },
        email: { deliver: delivered, emailIngress }
      },
      { onMessage }
    );

    const response = await channelHost.handleRequest(
      new Request("https://example.com/failing", { method: "POST" })
    );

    expect(response?.status).toBe(500);
    await expect(channelHost.handleEmail(emailInput())).rejects.toThrow(
      "durable handoff failed"
    );
  });
});
