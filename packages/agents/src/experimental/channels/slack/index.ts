import type { Channel, ChannelMessage, ChannelRoute } from "../channel";
import type { ChannelIdentity } from "../identity";
import type { ChannelMessageSurface } from "../surface";
import {
  matchesPath,
  type ChannelApprovalResponseInput,
  type ChannelInboundMessageInput,
  type ChannelIngress
} from "../ingress";
import { emptyIngressResponse, encodeUtf8, isRecord } from "../internal";

/** The subset of a Slack event used by the adapter, with unknown fields retained. */
export type SlackEvent = {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  [key: string]: unknown;
};

export type SlackAuthorization = {
  team_id?: string;
  user_id?: string;
  is_bot?: boolean;
  [key: string]: unknown;
};

/** A typed Slack Events API callback retained in an ingress envelope. */
export type SlackEventCallback = {
  type: "event_callback";
  event_id: string;
  team_id: string;
  event: SlackEvent;
  authorizations?: readonly SlackAuthorization[];
  [key: string]: unknown;
};

/** A typed Slack URL verification request. */
export type SlackUrlVerification = {
  type: "url_verification";
  challenge: string;
  [key: string]: unknown;
};

export type SlackBlockAction = {
  action_id?: string;
  action_ts?: string;
  value?: string;
  [key: string]: unknown;
};

/** A typed Slack Block Kit interaction retained in an ingress envelope. */
export type SlackBlockActions = {
  type: "block_actions";
  team?: { id?: string; [key: string]: unknown };
  user?: {
    id?: string;
    username?: string;
    name?: string;
    [key: string]: unknown;
  };
  channel?: { id?: string; [key: string]: unknown };
  message?: {
    ts?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };
  container?: {
    channel_id?: string;
    message_ts?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };
  actions?: readonly SlackBlockAction[];
  [key: string]: unknown;
};

/** Authenticated Slack payloads which may be passed to a Channel route. */
export type SlackIngressPayload = SlackEventCallback | SlackBlockActions;

/** Authenticated JSON payloads handled before routable events are emitted. */
type SlackJsonPayload = SlackEventCallback | SlackUrlVerification;

export type SlackWebhookOptions = {
  /** Slack app signing secret. */
  signingSecret: string;
  /** Exact webhook pathname accepted by this ingress. @default "/webhooks/slack" */
  path?: string;
  /** Maximum accepted request timestamp skew in seconds. @default 300 */
  maxSkewSeconds?: number;
  /** Bot user id used to discard events sent by this app. */
  botUserId?: string;
};

export type SlackMessageSurface = ChannelMessageSurface<
  string,
  | {
      channelId: string;
      threadTs?: string;
      /** The reader a channel stream is rendered for. Slack requires it. */
      recipientUserId?: string;
      recipientTeamId?: string;
    }
  | { teamId: string; userId: string }
>;

/** Configuration for a Slack Channel. */
export type SlackChannelOptions = {
  /** Bot token used with chat.postMessage. */
  botToken: string;
  /** Slack Web API origin. @default "https://slack.com/api" */
  apiBaseUrl?: string;
  /** Project canonical Channel Markdown into Slack mrkdwn text. */
  toText?: (message: ChannelMessage) => string;
  /**
   * Smallest gap between `chat.appendStream` calls. Chunks produced inside
   * one interval are appended together. @default 500
   */
  streamIntervalMs?: number;
  /** Add signed Slack HTTP ingress to the returned Channel. */
  webhook?: SlackWebhookOptions;
  /** Select an application route from the event, exact payload, and Host context. */
  route?: ChannelRoute<SlackIngressPayload>;
  /** Override fetch for testing or custom network routing. */
  fetch?: typeof globalThis.fetch;
};

type ApprovalValue = {
  v: 1;
  approvalId: string;
  decision: "approve" | "reject";
};

const DEFAULT_SLACK_WEBHOOK_PATH = "/webhooks/slack";
const DEFAULT_MAX_SKEW_SECONDS = 5 * 60;
const APPROVE_ACTION_ID = "cloudflare_channels_approve_v1";
const REJECT_ACTION_ID = "cloudflare_channels_reject_v1";
function channelIdentity(teamId: string, channelId: string): string {
  return `slack:${teamId}:channel:${channelId}`;
}

function messageIdentity(
  teamId: string,
  channelId: string,
  timestamp: string
): string {
  return `${channelIdentity(teamId, channelId)}:message:${timestamp}`;
}

function replySurfaceLabel(
  channelId: string,
  threadTimestamp: string | undefined
): string {
  return threadTimestamp
    ? `Slack · ${channelId} · thread ${threadTimestamp}`
    : `Slack · ${channelId}`;
}

function threadIdentity(
  teamId: string,
  channelId: string,
  timestamp: string,
  threadTimestamp: string | undefined,
  isDirectMessage: boolean
): string {
  const channel = channelIdentity(teamId, channelId);
  if (isDirectMessage && threadTimestamp === undefined) return channel;
  return `${channel}:thread:${threadTimestamp ?? timestamp}`;
}

function slackTimestamp(timestamp: string): string | undefined {
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

function selfUserIds(
  payload: SlackEventCallback,
  configuredBotUserId: string | undefined
): Set<string> {
  const ids = new Set<string>();
  if (configuredBotUserId) ids.add(configuredBotUserId);
  if (Array.isArray(payload.authorizations)) {
    for (const authorization of payload.authorizations) {
      if (
        authorization?.is_bot === true &&
        typeof authorization.user_id === "string"
      ) {
        ids.add(authorization.user_id);
      }
    }
  }
  return ids;
}

function normalizedEvent(
  payload: SlackEventCallback,
  configuredBotUserId: string | undefined
): ChannelInboundMessageInput | undefined {
  const event = payload.event;
  if (!event || !isRecord(event)) return undefined;

  if (event.type !== "app_mention" && event.type !== "message") {
    return undefined;
  }
  const isMention = event.type === "app_mention";
  const isDirectMessage =
    event.type === "message" && event.channel_type === "im";

  if (
    event.subtype !== undefined ||
    typeof event.bot_id === "string" ||
    typeof event.app_id === "string"
  ) {
    return undefined;
  }

  const teamId = payload.team_id;
  const eventId = payload.event_id;
  const channelId = event.channel;
  const actorId = event.user;
  const text = event.text;
  const timestamp = event.ts;
  if (
    typeof teamId !== "string" ||
    typeof eventId !== "string" ||
    typeof channelId !== "string" ||
    typeof actorId !== "string" ||
    typeof text !== "string" ||
    typeof timestamp !== "string"
  ) {
    return undefined;
  }

  if (selfUserIds(payload, configuredBotUserId).has(actorId)) {
    return undefined;
  }

  const threadTimestamp =
    typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  const sentAt = slackTimestamp(timestamp);
  return {
    type: "message",
    eventId: `slack:${teamId}:event:${eventId}`,
    thread: {
      id: threadIdentity(
        teamId,
        channelId,
        timestamp,
        threadTimestamp,
        isDirectMessage
      ),
      isDirectMessage
    },
    replySurface: {
      version: 1,
      address: {
        teamId,
        channelId,
        ...((threadTimestamp || !isDirectMessage) && {
          threadTs: threadTimestamp ?? timestamp
        }),
        // Preserve the reader even for a known DM conversation so outbound
        // routing can distinguish it from a top-level public channel.
        recipientUserId: actorId,
        recipientTeamId: teamId
      },
      label: replySurfaceLabel(
        channelId,
        threadTimestamp ?? (isDirectMessage ? undefined : timestamp)
      )
    },
    actor: {
      id: `slack:${teamId}:user:${actorId}`,
      identity: {
        scope: teamId,
        subject: actorId
      },
      isBot: false,
      isSelf: false
    },
    message: {
      id: messageIdentity(teamId, channelId, timestamp),
      text,
      markdown: text,
      ...(isMention && { isMention: true }),
      ...(threadTimestamp &&
        threadTimestamp !== timestamp && {
          reply: {
            id: messageIdentity(teamId, channelId, threadTimestamp)
          }
        }),
      ...(sentAt && { metadata: { sentAt } })
    }
  };
}

function parseApprovalValue(value: string): ApprovalValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    typeof parsed.approvalId !== "string" ||
    !parsed.approvalId ||
    (parsed.decision !== "approve" && parsed.decision !== "reject")
  ) {
    return undefined;
  }
  return parsed as ApprovalValue;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encodeUtf8(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function normalizedInteractions(
  payload: SlackBlockActions,
  rawBody: string
): Promise<readonly ChannelApprovalResponseInput[]> {
  const teamId = payload.team?.id;
  const actorId = payload.user?.id;
  const channelId =
    typeof payload.channel?.id === "string"
      ? payload.channel.id
      : payload.container?.channel_id;
  const timestamp =
    typeof payload.message?.ts === "string"
      ? payload.message.ts
      : payload.container?.message_ts;
  if (
    typeof teamId !== "string" ||
    typeof actorId !== "string" ||
    typeof channelId !== "string" ||
    typeof timestamp !== "string" ||
    !Array.isArray(payload.actions)
  ) {
    return [];
  }

  const threadTimestamp =
    typeof payload.message?.thread_ts === "string"
      ? payload.message.thread_ts
      : typeof payload.container?.thread_ts === "string"
        ? payload.container.thread_ts
        : undefined;
  const isDirectMessage = channelId.startsWith("D");
  const bodyHash = await sha256Hex(rawBody);
  const events: ChannelApprovalResponseInput[] = [];

  for (const [index, action] of payload.actions.entries()) {
    if (!action || typeof action.value !== "string") continue;
    const expectedDecision =
      action.action_id === APPROVE_ACTION_ID
        ? "approve"
        : action.action_id === REJECT_ACTION_ID
          ? "reject"
          : undefined;
    if (!expectedDecision) continue;

    const approval = parseApprovalValue(action.value);
    if (!approval || approval.decision !== expectedDecision) continue;

    const stableEventId = `slack:${teamId}:interaction:sha256:${bodyHash}:action:${index}`;
    const actionTimestamp =
      typeof action.action_ts === "string" ? action.action_ts : undefined;
    events.push({
      type: "approval-response",
      eventId: stableEventId,
      thread: {
        id: threadIdentity(
          teamId,
          channelId,
          timestamp,
          threadTimestamp,
          isDirectMessage
        ),
        isDirectMessage
      },
      replySurface: {
        version: 1,
        address: {
          teamId,
          channelId,
          threadTs: threadTimestamp ?? timestamp,
          ...(!isDirectMessage && {
            recipientUserId: actorId,
            recipientTeamId: teamId
          })
        },
        label: replySurfaceLabel(channelId, threadTimestamp ?? timestamp)
      },
      actor: {
        id: `slack:${teamId}:user:${actorId}`,
        identity: {
          scope: teamId,
          subject: actorId
        },
        ...(typeof payload.user?.username === "string" && {
          username: payload.user.username
        }),
        isBot: false
      },
      approvalId: approval.approvalId,
      decision: approval.decision,
      reference: actionTimestamp
        ? `${channelIdentity(teamId, channelId)}:action:${actionTimestamp}`
        : stableEventId
    });
  }

  return events;
}

function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[a-f0-9]{64}$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function hasValidSignature(
  request: Request,
  rawBody: string,
  signingSecret: string,
  maxSkewSeconds: number
): Promise<boolean> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > maxSkewSeconds
  ) {
    return false;
  }

  const match = signature.match(/^v0=([a-f0-9]{64})$/);
  const signatureBytes = match ? bytesFromHex(match[1]) : undefined;
  if (!signatureBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encodeUtf8(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encodeUtf8(`v0:${timestamp}:${rawBody}`)
  );
}

function parseJsonPayload(rawBody: string): SlackJsonPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.type !== "url_verification" && parsed.type !== "event_callback") {
    return undefined;
  }
  return parsed as SlackUrlVerification | SlackEventCallback;
}

function parseInteractionPayload(
  rawBody: string
): SlackBlockActions | undefined {
  const encodedPayload = new URLSearchParams(rawBody).get("payload");
  if (!encodedPayload) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedPayload);
  } catch {
    return undefined;
  }
  return isRecord(parsed) && parsed.type === "block_actions"
    ? (parsed as SlackBlockActions)
    : undefined;
}

/** Create dependency-free, request-signed Slack HTTP ingress. */
export function slackWebhook(
  options: SlackWebhookOptions
): ChannelIngress<SlackIngressPayload> {
  if (!options.signingSecret.trim()) {
    throw new Error(
      "signingSecret is required to create Slack webhook ingress"
    );
  }
  const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (!Number.isInteger(maxSkewSeconds) || maxSkewSeconds < 0) {
    throw new Error("maxSkewSeconds must be a non-negative integer");
  }

  const path = options.path ?? DEFAULT_SLACK_WEBHOOK_PATH;
  return {
    async receive(request) {
      if (!matchesPath(request, path)) return null;
      if (request.method !== "POST") return emptyIngressResponse(405);

      const rawBody = await request.text();
      if (
        !(await hasValidSignature(
          request,
          rawBody,
          options.signingSecret,
          maxSkewSeconds
        ))
      ) {
        return emptyIngressResponse(401);
      }

      const contentType =
        request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      if (contentType === "application/x-www-form-urlencoded") {
        const payload = parseInteractionPayload(rawBody);
        if (!payload) return emptyIngressResponse(400);
        const events = await normalizedInteractions(payload, rawBody);
        return {
          events: events.map((event) => ({ event, raw: payload })),
          response: new Response(null, { status: 200 })
        };
      }

      const payload = parseJsonPayload(rawBody);
      if (!payload) return emptyIngressResponse(400);
      if (payload.type === "url_verification") {
        return typeof payload.challenge === "string"
          ? {
              events: [],
              response: Response.json({ challenge: payload.challenge })
            }
          : emptyIngressResponse(400);
      }

      const event = normalizedEvent(payload, options.botUserId);
      return {
        events: event ? [{ event, raw: payload }] : [],
        response: new Response(null, { status: 200 })
      };
    }
  };
}

/** Create a configured Slack ingress Channel. */
export function slack(
  options: SlackChannelOptions
): Channel<SlackIngressPayload> {
  if (!options.botToken.trim()) {
    throw new Error("botToken is required to create a Slack channel");
  }
  const ingress = options.webhook ? slackWebhook(options.webhook) : undefined;

  return {
    ...(options.route && { route: options.route }),
    ...(ingress && { ingress }),
    contactSurface(identity: ChannelIdentity) {
      if (identity.scope === undefined) return null;
      return {
        version: 1,
        address: { teamId: identity.scope, userId: identity.subject },
        label: `Slack · user ${identity.subject}`
      };
    }
  };
}
