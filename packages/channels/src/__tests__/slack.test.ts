import { describe, expect, it, vi } from "vitest";
import { ChannelHost } from "..";
import {
  slack,
  slackWebhook,
  type SlackBlockActions,
  type SlackEventCallback,
  type SlackIngressPayload
} from "../adapters/slack";

const BOT_TOKEN = "xoxb-secret-token";
const SIGNING_SECRET = "slack-signing-secret";
const SLACK_SURFACE = {
  channelKey: "slack",
  version: 1,
  address: { channelId: "CDEST" },
  label: "Slack · CDEST"
} as const;
const encoder = new TextEncoder();

async function signature(body: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`)
  );
  return `v0=${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

async function signedRequest(
  body: string,
  options: {
    contentType?: string;
    timestamp?: number;
    signatureBody?: string;
    path?: string;
  } = {}
): Promise<Request> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  return new Request(
    `https://example.com${options.path ?? "/webhooks/slack"}`,
    {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": await signature(
          options.signatureBody ?? body,
          timestamp
        )
      },
      body
    }
  );
}

async function receiveJson(payload: SlackEventCallback) {
  const webhook = slackWebhook({ signingSecret: SIGNING_SECRET });
  const result = await webhook.receive(
    await signedRequest(JSON.stringify(payload))
  );
  if (!result) throw new Error("Expected Slack ingress to claim its path");
  return result;
}

describe("Slack signed ingress", () => {
  it("authenticates the exact raw challenge body and enforces timestamp skew", async () => {
    const webhook = slackWebhook({ signingSecret: SIGNING_SECRET });
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-value"
    });

    await expect(
      webhook.receive(
        await signedRequest(body, { path: "/anything/webhooks/slack" })
      )
    ).resolves.toBeNull();

    const verified = await webhook.receive(await signedRequest(body));
    if (!verified) throw new Error("Expected Slack ingress to claim its path");
    expect(verified.response.status).toBe(200);
    await expect(verified.response.json()).resolves.toEqual({
      challenge: "challenge-value"
    });

    const altered = `${body} `;
    const invalid = await webhook.receive(
      await signedRequest(altered, { signatureBody: body })
    );
    if (!invalid) throw new Error("Expected Slack ingress to claim its path");
    expect(invalid.response.status).toBe(401);

    const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
    const stale = await webhook.receive(
      await signedRequest(body, { timestamp: staleTimestamp })
    );
    if (!stale) throw new Error("Expected Slack ingress to claim its path");
    expect(stale.response.status).toBe(401);
  });

  it("normalizes an app mention and gives its exact typed payload to the route", async () => {
    const route = vi.fn(
      async (_event: unknown, _raw: SlackIngressPayload) => "workspace-route"
    );
    const channel = slack({
      botToken: BOT_TOKEN,
      webhook: { signingSecret: SIGNING_SECRET, botUserId: "UBOT" },
      route
    });
    const payload: SlackEventCallback = {
      type: "event_callback",
      event_id: "Ev-mention-1",
      team_id: "TWORK",
      trace_context: { retained: true },
      authorizations: [{ user_id: "UBOT", is_bot: true }],
      event: {
        type: "app_mention",
        user: "UHUMAN",
        text: "<@UBOT> please help",
        channel: "CGENERAL",
        ts: "1710000001.000200",
        thread_ts: "1710000000.000100"
      }
    };

    const result = await channel.ingress?.receive(
      await signedRequest(JSON.stringify(payload))
    );
    expect(result?.response.status).toBe(200);
    expect(result?.events).toHaveLength(1);
    const envelope = result?.events[0];
    expect(envelope?.raw).toEqual(payload);
    expect(envelope?.event).toEqual({
      type: "message",
      eventId: "slack:TWORK:event:Ev-mention-1",
      thread: {
        id: "slack:TWORK:channel:CGENERAL:thread:1710000000.000100",
        isDirectMessage: false
      },
      replySurface: {
        version: 1,
        address: {
          teamId: "TWORK",
          channelId: "CGENERAL",
          threadTs: "1710000000.000100"
        },
        label: "Slack · CGENERAL · thread 1710000000.000100"
      },
      actor: {
        id: "slack:TWORK:user:UHUMAN",
        identity: {
          scope: "TWORK",
          subject: "UHUMAN"
        },
        isBot: false,
        isSelf: false
      },
      message: {
        id: "slack:TWORK:channel:CGENERAL:message:1710000001.000200",
        text: "<@UBOT> please help",
        markdown: "<@UBOT> please help",
        isMention: true,
        reply: {
          id: "slack:TWORK:channel:CGENERAL:message:1710000000.000100"
        },
        metadata: { sentAt: "2024-03-09T16:00:01.000Z" }
      }
    });

    if (!envelope) throw new Error("Expected a Slack ingress envelope");
    const context = { findUser: async () => null };
    await expect(
      channel.route?.(envelope.event, envelope.raw, context)
    ).resolves.toBe("workspace-route");
    expect(route).toHaveBeenCalledWith(envelope.event, envelope.raw, context);
  });

  it("uses the DM channel for unthreaded continuity and the root for threaded DMs", async () => {
    const unthreaded = await receiveJson({
      type: "event_callback",
      event_id: "Ev-dm-1",
      team_id: "TWORK",
      event: {
        type: "message",
        channel_type: "im",
        user: "UHUMAN",
        text: "hello",
        channel: "D123",
        ts: "1710000100.000100"
      }
    });
    const threaded = await receiveJson({
      type: "event_callback",
      event_id: "Ev-dm-2",
      team_id: "TWORK",
      event: {
        type: "message",
        channel_type: "im",
        user: "UHUMAN",
        text: "follow-up",
        channel: "D123",
        ts: "1710000101.000200",
        thread_ts: "1710000100.000100"
      }
    });

    expect(unthreaded.events[0]?.event.thread).toEqual({
      id: "slack:TWORK:channel:D123",
      isDirectMessage: true
    });
    expect(threaded.events[0]?.event.thread).toEqual({
      id: "slack:TWORK:channel:D123:thread:1710000100.000100",
      isDirectMessage: true
    });
    expect(threaded.events[0]?.event).toMatchObject({
      eventId: "slack:TWORK:event:Ev-dm-2",
      actor: { id: "slack:TWORK:user:UHUMAN" },
      message: {
        id: "slack:TWORK:channel:D123:message:1710000101.000200",
        reply: {
          id: "slack:TWORK:channel:D123:message:1710000100.000100"
        }
      }
    });
  });

  it("offers channel messages to routing and keeps a mention with its replies", async () => {
    const mention = await receiveJson({
      type: "event_callback",
      event_id: "Ev-channel-mention",
      team_id: "TWORK",
      event: {
        type: "app_mention",
        user: "UHUMAN",
        text: "<@UBOT> please help",
        channel: "CHELP",
        channel_type: "channel",
        ts: "1710000300.000100"
      }
    });
    const reply = await receiveJson({
      type: "event_callback",
      event_id: "Ev-channel-reply",
      team_id: "TWORK",
      event: {
        type: "message",
        user: "UHUMAN",
        text: "one more detail",
        channel: "CHELP",
        channel_type: "channel",
        ts: "1710000301.000200",
        thread_ts: "1710000300.000100"
      }
    });
    const standalone = await receiveJson({
      type: "event_callback",
      event_id: "Ev-channel-standalone",
      team_id: "TWORK",
      event: {
        type: "message",
        user: "UHUMAN",
        text: "general chatter",
        channel: "CHELP",
        channel_type: "channel",
        ts: "1710000400.000100"
      }
    });

    expect(mention.events[0]?.event.thread.id).toBe(
      "slack:TWORK:channel:CHELP:thread:1710000300.000100"
    );
    expect(reply.events[0]?.event.thread.id).toBe(
      mention.events[0]?.event.thread.id
    );
    expect(reply.events[0]?.event).toMatchObject({
      thread: { isDirectMessage: false },
      replySurface: {
        address: { threadTs: "1710000300.000100" },
        label: "Slack · CHELP · thread 1710000300.000100"
      }
    });
    expect(standalone.events[0]?.event).toMatchObject({
      thread: {
        id: "slack:TWORK:channel:CHELP:thread:1710000400.000100",
        isDirectMessage: false
      },
      replySurface: {
        address: { threadTs: "1710000400.000100" },
        label: "Slack · CHELP · thread 1710000400.000100"
      }
    });
  });

  it("runs routing for a plain channel thread reply", async () => {
    const route = vi.fn((event) => event.thread.id);
    const onRoute = vi.fn();
    const onMessage = vi.fn();
    const channelHost = new ChannelHost({
      channels: {
        slack: slack({
          botToken: BOT_TOKEN,
          webhook: { signingSecret: SIGNING_SECRET },
          route
        })
      },
      onRoute,
      onMessage
    });
    const payload: SlackEventCallback = {
      type: "event_callback",
      event_id: "Ev-routed-reply",
      team_id: "TWORK",
      event: {
        type: "message",
        user: "UHUMAN",
        text: "following up",
        channel: "CHELP",
        channel_type: "channel",
        ts: "1710000501.000200",
        thread_ts: "1710000500.000100"
      }
    };

    await channelHost.handleRequest(
      await signedRequest(JSON.stringify(payload))
    );

    expect(route).toHaveBeenCalledOnce();
    expect(onRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "slack",
        route: "slack:TWORK:channel:CHELP:thread:1710000500.000100"
      })
    );
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "unsupported event",
      payload: {
        type: "event_callback" as const,
        event_id: "Ev-unsupported",
        team_id: "TWORK",
        event: { type: "reaction_added", user: "UHUMAN" }
      }
    },
    {
      name: "bot message",
      payload: {
        type: "event_callback" as const,
        event_id: "Ev-bot",
        team_id: "TWORK",
        event: {
          type: "message",
          channel_type: "im",
          user: "UBOT",
          bot_id: "B123",
          text: "automated",
          channel: "D123",
          ts: "1710000200.000100"
        }
      }
    },
    {
      name: "self message",
      payload: {
        type: "event_callback" as const,
        event_id: "Ev-self",
        team_id: "TWORK",
        authorizations: [{ user_id: "UBOT", is_bot: true }],
        event: {
          type: "message",
          channel_type: "im",
          user: "UBOT",
          text: "echo",
          channel: "D123",
          ts: "1710000201.000100"
        }
      }
    }
  ])("safely ignores $name", async ({ payload }) => {
    const result = await receiveJson(payload);
    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([]);
  });
});

describe("Slack interactions and delivery outcomes", () => {
  it("derives actor contact surfaces independently from reply surfaces", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/conversations.open")
        ? Response.json({ ok: true, channel: { id: "DADA" } })
        : Response.json({ ok: true, channel: "DADA", ts: "1711000000.1" })
    );
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch
    });
    const channelHost = new ChannelHost({
      channels: { slack: channel },
      onMessage() {}
    });
    const contact = channelHost.contactSurface({
      channelKey: "slack",
      scope: "TWORK",
      subject: "UADA"
    });

    expect(contact).toEqual({
      channelKey: "slack",
      version: 1,
      address: { teamId: "TWORK", userId: "UADA" },
      label: "Slack · user UADA"
    });
    if (!contact) throw new Error("Expected a Slack contact surface");
    await channelHost.deliver(contact, { markdown: "Hello Ada" });

    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      channel: "DADA",
      text: "Hello Ada",
      mrkdwn: true
    });
  });

  it("rejects malformed persisted surfaces before delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch
    });

    await expect(
      channel.deliver(
        {
          channelKey: "slack",
          version: 1,
          address: null,
          label: "Slack · invalid"
        },
        { markdown: "Hello" }
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "SLACK_SURFACE_INVALID",
        message: 'Slack cannot parse the address for Channel "slack"'
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("delivers on a persisted reply surface with its thread context", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, channel: "CHELP", ts: "1711000000.2" })
    );
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch
    });
    const replySurface = {
      channelKey: "slack",
      version: 1,
      address: {
        teamId: "TWORK",
        channelId: "CHELP",
        threadTs: "1710000000.1"
      },
      label: "Slack · CHELP · thread 1710000000.1"
    } as const;

    await channel.deliver(JSON.parse(JSON.stringify(replySurface)), {
      markdown: "Following up"
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      channel: "CHELP",
      text: "Following up",
      mrkdwn: true,
      thread_ts: "1710000000.1"
    });
  });

  it("rejects an empty approval interaction id before delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch
    });

    await expect(
      channel.requestApproval?.(SLACK_SURFACE, {
        interactionId: "",
        request: { summary: "Deploy?", input: {} }
      })
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "SLACK_INTERACTION_ID_REQUIRED",
        message: "Slack approval requests require a non-empty interaction id"
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a rate limit as a retryable confirmed failure",
      response: () =>
        Response.json({ ok: false, error: "ratelimited" }, { status: 429 }),
      expected: {
        status: "failed",
        retryable: true,
        error: {
          code: "SLACK_API_ERROR_RATELIMITED",
          message: "Slack rejected the message: ratelimited"
        }
      }
    },
    {
      name: "a permanent API error as a non-retryable confirmed failure",
      response: () => Response.json({ ok: false, error: "channel_not_found" }),
      expected: {
        status: "failed",
        retryable: false,
        error: {
          code: "SLACK_API_ERROR_CHANNEL_NOT_FOUND",
          message: "Slack rejected the message: channel_not_found"
        }
      }
    },
    {
      name: "an ambiguous API error as uncertain",
      response: () => Response.json({ ok: false, error: "internal_error" }),
      expected: {
        status: "uncertain",
        error: {
          code: "SLACK_API_ERROR_INTERNAL_ERROR",
          message: "Slack rejected the message: internal_error"
        }
      }
    },
    {
      name: "an HTTP 5xx response as uncertain",
      response: () =>
        Response.json({ ok: false, error: "server_error" }, { status: 503 }),
      expected: {
        status: "uncertain",
        error: {
          code: "SLACK_API_ERROR_SERVER_ERROR",
          message: "Slack rejected the message: server_error"
        }
      }
    },
    {
      name: "malformed JSON as uncertain",
      response: () => new Response("not-json"),
      expected: {
        status: "uncertain",
        error: {
          code: "SLACK_DELIVERY_ERROR",
          message: "Slack returned an invalid delivery response"
        }
      }
    },
    {
      name: "a malformed ok:true response as uncertain",
      response: () => Response.json({ ok: true }),
      expected: {
        status: "uncertain",
        error: {
          code: "SLACK_DELIVERY_ERROR",
          message: "Slack returned an invalid delivery response"
        }
      }
    }
  ])("classifies $name", async ({ response, expected }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch
    });

    await expect(
      channel.deliver(SLACK_SURFACE, { markdown: "Help" })
    ).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("round-trips a versioned interaction id and derives a stable action event id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ok: true, channel: "CAPPROVAL", ts: "1711000000.1" })
    );
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch,
      webhook: { signingSecret: SIGNING_SECRET }
    });

    await expect(
      channel.requestApproval?.(SLACK_SURFACE, {
        interactionId: "approval-42",
        request: {
          title: "Approval required",
          summary: "Deploy production?",
          input: { version: "1.2.3" }
        }
      })
    ).resolves.toEqual({
      status: "delivered",
      reference: "slack:channel:CAPPROVAL:message:1711000000.1"
    });

    const requestInit = fetch.mock.calls[0]?.[1];
    const outbound = JSON.parse(String(requestInit?.body)) as {
      blocks: Array<{
        elements?: Array<{ action_id: string; value: string }>;
      }>;
    };
    const approveButton = outbound.blocks[1]?.elements?.[0];
    expect(JSON.parse(approveButton?.value ?? "")).toEqual({
      v: 1,
      interactionId: "approval-42",
      decision: "approve"
    });

    const payload: SlackBlockActions = {
      type: "block_actions",
      team: { id: "TWORK" },
      user: { id: "UAPPROVER", username: "ada" },
      channel: { id: "CAPPROVAL" },
      message: {
        ts: "1711000000.1",
        thread_ts: "1710000000.1"
      },
      actions: [
        { action_id: "unrelated", value: "ignored" },
        {
          action_id: approveButton?.action_id,
          action_ts: "1711000001.2",
          value: approveButton?.value
        }
      ]
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload)
    }).toString();
    const first = await channel.ingress?.receive(
      await signedRequest(body, {
        contentType: "application/x-www-form-urlencoded"
      })
    );
    const second = await channel.ingress?.receive(
      await signedRequest(body, {
        contentType: "application/x-www-form-urlencoded"
      })
    );

    expect(first?.events).toHaveLength(1);
    expect(first?.events[0]?.raw).toEqual(payload);
    expect(first?.events[0]?.event).toMatchObject({
      type: "approval-response",
      interactionId: "approval-42",
      decision: "approve",
      thread: {
        id: "slack:TWORK:channel:CAPPROVAL:thread:1710000000.1",
        isDirectMessage: false
      },
      actor: {
        id: "slack:TWORK:user:UAPPROVER",
        identity: {
          scope: "TWORK",
          subject: "UAPPROVER"
        },
        username: "ada",
        isBot: false
      },
      reference: "slack:TWORK:channel:CAPPROVAL:action:1711000001.2"
    });
    const eventId = first?.events[0]?.event.eventId;
    expect(eventId).toMatch(
      /^slack:TWORK:interaction:sha256:[a-f0-9]{64}:action:1$/
    );
    expect(second?.events[0]?.event.eventId).toBe(eventId);
  });

  it("classifies an ambiguous chat.postMessage failure as uncertain without claiming idempotency", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError(
        `fetch failed for Bearer ${BOT_TOKEN} after writing the request`
      );
    });
    const channel = slack({ botToken: BOT_TOKEN, fetch });
    const threadSurface = {
      ...SLACK_SURFACE,
      address: { channelId: "CDEST", threadTs: "1710000000.1" },
      label: "Slack · CDEST · thread 1710000000.1"
    };

    const result = await channel.deliver(
      threadSurface,
      { title: "Build blocked", markdown: "Please **help**" },
      { deliveryId: "caller-delivery-1" }
    );

    expect(result).toEqual({
      status: "uncertain",
      error: {
        code: "SLACK_DELIVERY_ERROR",
        message: "Slack delivery failed with an unknown outcome"
      }
    });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    const outbound = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(outbound).toEqual({
      channel: "CDEST",
      text: "Build blocked\n\nPlease **help**",
      mrkdwn: true,
      thread_ts: "1710000000.1"
    });
    expect(outbound).not.toHaveProperty("client_msg_id");
  });
});
