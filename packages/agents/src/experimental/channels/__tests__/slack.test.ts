import { describe, expect, it, vi } from "vitest";
import {
  slack,
  slackWebhook,
  type SlackBlockActions,
  type SlackEventCallback,
  type SlackIngressPayload
} from "../slack";

const BOT_TOKEN = "xoxb-secret-token";
const SIGNING_SECRET = "slack-signing-secret";
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
          threadTs: "1710000000.000100",
          recipientUserId: "UHUMAN",
          recipientTeamId: "TWORK"
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
    expect(unthreaded.events[0]?.event.replySurface).toMatchObject({
      address: {
        teamId: "TWORK",
        channelId: "D123",
        recipientUserId: "UHUMAN",
        recipientTeamId: "TWORK"
      }
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

describe("Slack approval ingress", () => {
  it("normalizes a hand-built versioned button value", async () => {
    const channel = slack({
      botToken: BOT_TOKEN,
      webhook: { signingSecret: SIGNING_SECRET }
    });
    const payload: SlackBlockActions = {
      type: "block_actions",
      team: { id: "TWORK" },
      user: { id: "UAPPROVER", username: "ada" },
      channel: { id: "CAPPROVAL" },
      message: { ts: "1711000000.1", thread_ts: "1710000000.1" },
      actions: [
        {
          action_id: "cloudflare_channels_approve_v1",
          action_ts: "1711000001.2",
          value: JSON.stringify({
            v: 1,
            approvalId: "approval-42",
            decision: "approve"
          })
        }
      ]
    };
    const body = new URLSearchParams({
      payload: JSON.stringify(payload)
    }).toString();
    const result = await channel.ingress?.receive(
      await signedRequest(body, {
        contentType: "application/x-www-form-urlencoded"
      })
    );

    expect(result?.events).toHaveLength(1);
    expect(result?.events[0]?.raw).toEqual(payload);
    expect(result?.events[0]?.event).toMatchObject({
      type: "approval-response",
      approvalId: "approval-42",
      decision: "approve",
      thread: {
        id: "slack:TWORK:channel:CAPPROVAL:thread:1710000000.1",
        isDirectMessage: false
      },
      reference: "slack:TWORK:channel:CAPPROVAL:action:1711000001.2"
    });
  });
});
