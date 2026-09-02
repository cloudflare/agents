import type {
  Channel,
  ChannelApprovalRequest,
  ChannelChunk,
  ChannelMessage,
  ChannelRoute,
  ChannelStreamOptions,
  DeliveryResult
} from "../channel";
import { collectText, consumeChunks, createPacer } from "../stream";
import type { ChannelIdentity } from "../identity";
import {
  isChannelMessageSurface,
  type ChannelMessageSurface
} from "../surface";
import {
  matchesPath,
  type ChannelApprovalResponseInput,
  type ChannelInboundMessageInput,
  type ChannelIngress
} from "../ingress";
import {
  defaultText,
  emptyIngressResponse,
  encodeUtf8,
  isRecord,
  renderInput,
  uncertain
} from "../internal";

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

type SlackApiResponse = {
  ok?: unknown;
  error?: unknown;
  channel?: unknown;
  ts?: unknown;
};

type SlackOpenConversationResponse = {
  ok?: unknown;
  error?: unknown;
  channel?: { id?: unknown };
};

type ApprovalValue = {
  v: 1;
  interactionId: string;
  decision: "approve" | "reject";
};

const DEFAULT_SLACK_WEBHOOK_PATH = "/webhooks/slack";
const DEFAULT_MAX_SKEW_SECONDS = 5 * 60;
const APPROVE_ACTION_ID = "cloudflare_channels_approve_v1";
const REJECT_ACTION_ID = "cloudflare_channels_reject_v1";
const DEFAULT_STREAM_INTERVAL_MS = 500;
const SLACK_APPEND_LIMIT = 12_000;
const SLACK_TASK_FIELD_LIMIT = 256;
const SLACK_CONTEXT_LIMIT = 3000;
const AMBIGUOUS_SLACK_ERRORS = new Set([
  "fatal_error",
  "internal_error",
  "request_timeout",
  "service_unavailable"
]);

function approvalText(request: ChannelApprovalRequest): string {
  return [
    ...(request.title ? [request.title] : []),
    request.summary,
    `Input:\n\`\`\`\n${renderInput(request.input)}\n\`\`\``
  ].join("\n\n");
}

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

function outboundReference(channelId: string, timestamp: string): string {
  return `slack:channel:${channelId}:message:${timestamp}`;
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
        // Slack renders a channel stream for one reader, and requires both
        // ids to do it. A direct message already has a single reader.
        ...(!isDirectMessage && {
          recipientUserId: actorId,
          recipientTeamId: teamId
        })
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
    typeof parsed.interactionId !== "string" ||
    !parsed.interactionId ||
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
      interactionId: approval.interactionId,
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

function failed(
  code: string,
  message: string,
  retryable: boolean
): Extract<DeliveryResult, { status: "failed" }> {
  return {
    status: "failed",
    retryable,
    error: { code, message }
  };
}

function slackErrorCode(error: string): string {
  return `SLACK_API_ERROR_${error.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function classifyApiFailure(
  response: Response,
  payload: SlackApiResponse
): Exclude<DeliveryResult, { status: "delivered" }> {
  if (payload.ok === false) {
    const error =
      typeof payload.error === "string" ? payload.error : "unknown_error";
    const code = slackErrorCode(error);
    const message = `Slack rejected the message: ${error}`;
    if (response.status >= 500 || AMBIGUOUS_SLACK_ERRORS.has(error)) {
      return uncertain(code, message);
    }
    return failed(
      code,
      message,
      response.status === 429 || error === "ratelimited"
    );
  }

  if (response.status === 429) {
    return failed(
      "SLACK_HTTP_ERROR_429",
      "Slack rate limited the message",
      true
    );
  }
  if (response.status >= 400 && response.status < 500) {
    return failed(
      `SLACK_HTTP_ERROR_${response.status}`,
      `Slack rejected the message with HTTP ${response.status}`,
      false
    );
  }
  return uncertain(
    "SLACK_DELIVERY_ERROR",
    "Slack returned an invalid delivery response"
  );
}

function asApiResponse(value: unknown): SlackApiResponse | undefined {
  return isRecord(value) ? value : undefined;
}

function approvalValue(
  interactionId: string,
  decision: "approve" | "reject"
): string {
  return JSON.stringify({
    v: 1,
    interactionId,
    decision
  } satisfies ApprovalValue);
}

/** A resolved conversation, with the reader a stream should be rendered for. */
type SlackDestination = {
  channelId: string;
  threadTs?: string;
  recipientUserId?: string;
  recipientTeamId?: string;
};

type SlackTarget = SlackDestination | { teamId: string; userId: string };

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function slackTarget(surface: ChannelMessageSurface): SlackTarget | undefined {
  if (
    !isChannelMessageSurface(surface) ||
    surface.version !== 1 ||
    !isRecord(surface.address)
  ) {
    return undefined;
  }
  const address = surface.address;
  if ("userId" in address) {
    return typeof address.teamId === "string" &&
      address.teamId.length > 0 &&
      typeof address.userId === "string" &&
      address.userId.length > 0
      ? { teamId: address.teamId, userId: address.userId }
      : undefined;
  }
  if (typeof address.channelId !== "string" || address.channelId.length === 0) {
    return undefined;
  }
  if (
    "threadTs" in address &&
    address.threadTs !== undefined &&
    (typeof address.threadTs !== "string" || address.threadTs.length === 0)
  ) {
    return undefined;
  }
  const recipientUserId = optionalId(address.recipientUserId);
  const recipientTeamId = optionalId(address.recipientTeamId);
  return {
    channelId: address.channelId,
    ...(typeof address.threadTs === "string" && {
      threadTs: address.threadTs
    }),
    // Slack rejects one without the other, so only carry a complete pair.
    ...(recipientUserId &&
      recipientTeamId && { recipientUserId, recipientTeamId })
  };
}

type SlackStreamChunk =
  | { type: "markdown_text"; text: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "in_progress" | "complete" | "error";
      details?: string;
    };

const SLACK_TASK_STATUS = {
  started: "in_progress",
  completed: "complete",
  failed: "error"
} as const;

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}\u2026`;
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    pieces.push(text.slice(index, index + limit));
  }
  return pieces;
}

/**
 * Render a neutral chunk as Slack stream content.
 *
 * `reasoning` has no Slack rendering and is dropped. A `source` is collected
 * rather than appended, so it can be rendered once beneath the finished
 * message instead of interrupting the text.
 */
function toStreamChunks(
  chunk: ChannelChunk,
  sources: { url: string; title?: string }[]
): SlackStreamChunk[] {
  switch (chunk.type) {
    case "text":
      return splitText(chunk.text, SLACK_APPEND_LIMIT).map((text) => ({
        type: "markdown_text",
        text
      }));
    case "tool":
      return [
        {
          type: "task_update",
          id: chunk.name,
          title: clamp(chunk.title ?? chunk.name, SLACK_TASK_FIELD_LIMIT),
          status: SLACK_TASK_STATUS[chunk.status],
          ...(chunk.detail !== undefined && {
            details: clamp(chunk.detail, SLACK_TASK_FIELD_LIMIT)
          })
        }
      ];
    case "source":
      sources.push(chunk);
      return [];
    case "reasoning":
      return [];
  }
}

function sourcesBlock(
  sources: readonly { url: string; title?: string }[]
): Record<string, unknown> {
  const text = sources
    .map((source) => `<${source.url}|${source.title ?? source.url}>`)
    .join(" \u00b7 ");
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: clamp(text, SLACK_CONTEXT_LIMIT) }]
  };
}

/** Create a configured Slack Web API Channel. */
export function slack(
  options: SlackChannelOptions
): Channel<SlackIngressPayload> {
  if (!options.botToken.trim()) {
    throw new Error("botToken is required to create a Slack channel");
  }
  const fetch = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? "https://slack.com/api").replace(
    /\/$/,
    ""
  );
  const toText = options.toText ?? defaultText;
  const streamIntervalMs =
    options.streamIntervalMs ?? DEFAULT_STREAM_INTERVAL_MS;
  if (!Number.isInteger(streamIntervalMs) || streamIntervalMs < 0) {
    throw new Error("streamIntervalMs must be a non-negative integer");
  }
  const ingress = options.webhook ? slackWebhook(options.webhook) : undefined;

  async function resolveTarget(
    target: SlackTarget
  ): Promise<SlackDestination | DeliveryResult> {
    if (!("userId" in target)) return target;

    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/conversations.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.botToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ users: target.userId })
      });
    } catch {
      return failed(
        "SLACK_CONTACT_RESOLUTION_FAILED",
        "Slack could not resolve a direct-message destination",
        true
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failed(
        "SLACK_CONTACT_RESOLUTION_FAILED",
        "Slack returned an invalid direct-message destination",
        response.status === 429 || response.status >= 500
      );
    }
    const result = isRecord(payload)
      ? (payload as SlackOpenConversationResponse)
      : undefined;
    if (result?.ok === true && typeof result.channel?.id === "string") {
      return {
        channelId: result.channel.id,
        recipientUserId: target.userId,
        recipientTeamId: target.teamId
      };
    }
    const error = typeof result?.error === "string" ? result.error : "unknown";
    return failed(
      slackErrorCode(error),
      `Slack could not open a direct message: ${error}`,
      response.status === 429 ||
        response.status >= 500 ||
        error === "ratelimited"
    );
  }

  async function postMessage(
    destination: ChannelMessageSurface,
    text: string,
    blocks?: readonly Record<string, unknown>[]
  ): Promise<DeliveryResult> {
    const unresolvedTarget = slackTarget(destination);
    if (!unresolvedTarget) {
      return failed(
        "SLACK_SURFACE_INVALID",
        `Slack cannot parse the address for Channel "${destination.channelKey}"`,
        false
      );
    }

    const target = await resolveTarget(unresolvedTarget);
    if ("status" in target) return target;

    const sent = await callSlack("chat.postMessage", {
      channel: target.channelId,
      text,
      mrkdwn: true,
      ...(target.threadTs && { thread_ts: target.threadTs }),
      ...(blocks && { blocks })
    });
    return "status" in sent
      ? sent
      : {
          status: "delivered",
          reference: outboundReference(sent.channelId, sent.ts)
        };
  }

  /**
   * One transport path for every Slack method this Channel calls.
   *
   * Each of them answers with the conversation and timestamp on success, and
   * every failure mode is classified the same way, so posting and streaming
   * cannot drift apart.
   */
  async function callSlack(
    method: string,
    body: Record<string, unknown>
  ): Promise<
    | { channelId: string; ts: string }
    | Exclude<DeliveryResult, { status: "delivered" }>
  > {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.botToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body)
      });
    } catch {
      return uncertain(
        "SLACK_DELIVERY_ERROR",
        "Slack delivery failed with an unknown outcome"
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const apiResponse = asApiResponse(payload);
    if (
      apiResponse?.ok === true &&
      typeof apiResponse.channel === "string" &&
      typeof apiResponse.ts === "string"
    ) {
      return { channelId: apiResponse.channel, ts: apiResponse.ts };
    }
    return apiResponse?.ok === true
      ? uncertain(
          "SLACK_DELIVERY_ERROR",
          "Slack returned an invalid delivery response"
        )
      : classifyApiFailure(response, apiResponse ?? {});
  }

  async function streamMessage(
    destination: ChannelMessageSurface,
    chunks: ReadableStream<ChannelChunk>,
    streamOptions: ChannelStreamOptions
  ): Promise<DeliveryResult> {
    const unresolvedTarget = slackTarget(destination);
    if (!unresolvedTarget) {
      await chunks.cancel().catch(() => {});
      return failed(
        "SLACK_SURFACE_INVALID",
        `Slack cannot parse the address for Channel "${destination.channelKey}"`,
        false
      );
    }

    // Slack only permits native channel streaming in a thread. Preserve the
    // simpler top-level application API by collecting and posting one ordinary
    // message; direct-message targets still use native streaming.
    if (!("userId" in unresolvedTarget) && !unresolvedTarget.threadTs) {
      const collected = await collectText(chunks);
      if (collected.interrupted && collected.text.length === 0) {
        return failed(
          "SLACK_STREAM_INTERRUPTED",
          "The stream ended before producing any content to deliver",
          false
        );
      }
      const delivered = await postMessage(
        destination,
        toText({
          ...(streamOptions.title && { title: streamOptions.title }),
          markdown: collected.text
        })
      );
      if (!collected.interrupted || delivered.status !== "delivered") {
        return delivered;
      }
      return uncertain(
        "SLACK_STREAM_INTERRUPTED",
        "An incomplete answer was delivered because the stream ended early",
        delivered.reference
      );
    }

    const target = await resolveTarget(unresolvedTarget);
    if ("status" in target) {
      await chunks.cancel().catch(() => {});
      return target;
    }

    const started = await callSlack("chat.startStream", {
      channel: target.channelId,
      ...(target.threadTs && { thread_ts: target.threadTs }),
      ...(target.recipientUserId && {
        recipient_user_id: target.recipientUserId,
        recipient_team_id: target.recipientTeamId
      }),
      // Every call in a stream must use the mode the stream was opened in,
      // so the title goes in a chunk rather than `markdown_text`. Opening
      // with `markdown_text` makes Slack reject each later append with
      // `streaming_mode_mismatch`, losing the whole answer.
      ...(streamOptions.title && {
        chunks: [{ type: "markdown_text", text: `${streamOptions.title}\n\n` }]
      })
    });
    if ("status" in started) {
      await chunks.cancel().catch(() => {});
      return started;
    }

    const reference = outboundReference(started.channelId, started.ts);
    const sources: { url: string; title?: string }[] = [];
    const shouldFlush = createPacer(streamIntervalMs);
    let pending: SlackStreamChunk[] = [];
    let appendFailure:
      | Exclude<DeliveryResult, { status: "delivered" }>
      | undefined;

    return consumeChunks(chunks, {
      async onChunk(chunk) {
        pending.push(...toStreamChunks(chunk, sources));
        if (pending.length === 0 || !shouldFlush()) return;
        const appended = await callSlack("chat.appendStream", {
          channel: started.channelId,
          ts: started.ts,
          chunks: pending
        });
        pending = [];
        if ("status" in appended) {
          appendFailure = appended;
          // Stop reading, but still stop the stream: Slack leaves a message
          // stuck in its streaming state otherwise.
          throw new Error(appended.error.message);
        }
      },
      async onFinish(outcome) {
        // Whatever the pacer withheld rides along on the terminal call, so an
        // interrupted answer keeps its tail without an extra round trip.
        const stopped = await callSlack("chat.stopStream", {
          channel: started.channelId,
          ts: started.ts,
          ...(pending.length > 0 && !appendFailure && { chunks: pending }),
          ...(sources.length > 0 && { blocks: [sourcesBlock(sources)] })
        });
        if ("status" in stopped) {
          return uncertain(
            stopped.error.code,
            `Slack could not stop the stream: ${stopped.error.message}`,
            reference
          );
        }
        if (appendFailure) {
          return uncertain(
            appendFailure.error.code,
            appendFailure.error.message,
            reference
          );
        }
        if (outcome.interrupted) {
          return uncertain(
            "SLACK_STREAM_INTERRUPTED",
            "The answer ended early, so the Slack message is incomplete",
            reference
          );
        }
        return { status: "delivered", reference };
      }
    });
  }

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
    },
    deliver(destination, message) {
      return postMessage(destination, toText(message));
    },
    stream(destination, chunks, streamOptions) {
      return streamMessage(destination, chunks, streamOptions);
    },
    requestApproval(destination, { interactionId, request }) {
      if (interactionId.length === 0) {
        return Promise.resolve(
          failed(
            "SLACK_INTERACTION_ID_REQUIRED",
            "Slack approval requests require a non-empty interaction id",
            false
          )
        );
      }
      const text = approvalText(request);
      const approveValue = approvalValue(interactionId, "approve");
      const rejectValue = approvalValue(interactionId, "reject");
      if (
        text.length > 3000 ||
        approveValue.length > 2000 ||
        rejectValue.length > 2000
      ) {
        return Promise.resolve(
          failed(
            "SLACK_APPROVAL_TOO_LONG",
            "Slack approval content exceeds Block Kit limits",
            false
          )
        );
      }
      return postMessage(destination, text, [
        {
          type: "section",
          text: { type: "mrkdwn", text }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: APPROVE_ACTION_ID,
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              value: approveValue
            },
            {
              type: "button",
              action_id: REJECT_ACTION_ID,
              text: { type: "plain_text", text: "Reject" },
              style: "danger",
              value: rejectValue
            }
          ]
        }
      ]);
    }
  };
}
