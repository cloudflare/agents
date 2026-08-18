import type {
  Channel,
  ChannelApprovalRequest,
  ChannelMessage,
  DeliveryResult
} from "./channel";
import type {
  ChannelApprovalResponse,
  ChannelInboundMessage,
  ChannelIngress,
  ChannelIngressEvent,
  ChannelIngressResult
} from "./ingress";

/** Configuration for a destination-bound Telegram channel. */
export type TelegramChannelOptions = {
  /** Bot token issued by BotFather. */
  botToken: string;
  /** User, group, or channel chat id that receives every message. */
  chatId: string | number;
  /** Telegram Bot API origin. @default "https://api.telegram.org" */
  apiBaseUrl?: string;
  /** Maximum text length accepted by this route. @default 4096 */
  maxLength?: number;
  /** Project the canonical message into Telegram text. */
  toText?: (message: ChannelMessage) => string;
  /** Parse mode for caller-formatted delivery text. */
  parseMode?: "HTML" | "MarkdownV2";
  /** Add secret-verified Telegram webhook ingress to the returned Channel. */
  webhook?: {
    secretToken: string;
    /** Path mounted by the ChannelHost. @default "/webhooks/telegram" */
    path?: string;
  };
  /** Override fetch for testing or custom network routing. */
  fetch?: typeof globalThis.fetch;
};

type TelegramApiResponse = {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  description?: unknown;
};

type TelegramMessage = {
  message_id?: unknown;
  text?: unknown;
  chat?: { id?: unknown };
  from?: { id?: unknown; username?: unknown };
  reply_to_message?: {
    message_id?: unknown;
    text?: unknown;
  };
};

type TelegramUpdate = {
  message?: TelegramMessage;
};

const TELEGRAM_MESSAGE_LIMIT = 4096;
const DEFAULT_TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";
const APPROVAL_INSTRUCTIONS = "Reply YES to approve or NO to reject.";
const INTERACTION_MARKER = /^\[channel-interaction:([^\]\r\n]+)\]$/m;

function defaultText(message: ChannelMessage): string {
  return message.title
    ? `${message.title}\n\n${message.markdown}`
    : message.markdown;
}

function renderInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

function approvalText(
  interactionId: string,
  request: ChannelApprovalRequest
): string {
  return [
    ...(request.title ? [request.title] : []),
    request.summary,
    `Input:\n${renderInput(request.input)}`,
    APPROVAL_INSTRUCTIONS,
    `[channel-interaction:${interactionId}]`
  ].join("\n\n");
}

function uncertain(message: string): DeliveryResult {
  return {
    status: "uncertain",
    error: { code: "TELEGRAM_DELIVERY_ERROR", message }
  };
}

function asApiResponse(value: unknown): TelegramApiResponse | undefined {
  return value !== null && typeof value === "object"
    ? (value as TelegramApiResponse)
    : undefined;
}

function classifyResponse(
  response: Response,
  payload: TelegramApiResponse
): DeliveryResult {
  if (payload.ok === true) {
    const result = asApiResponse(payload.result) as
      | { message_id?: unknown }
      | undefined;
    if (typeof result?.message_id === "number") {
      return { status: "delivered", reference: String(result.message_id) };
    }
    return uncertain("Telegram returned an invalid delivery response");
  }

  if (payload.ok === false) {
    const errorCode =
      typeof payload.error_code === "number"
        ? payload.error_code
        : response.status;
    const message =
      typeof payload.description === "string"
        ? payload.description
        : "Telegram rejected the message";
    return {
      status: "failed",
      retryable: errorCode === 429 || errorCode >= 500,
      error: { code: `TELEGRAM_API_ERROR_${errorCode}`, message }
    };
  }

  return uncertain("Telegram returned an invalid delivery response");
}

export type TelegramWebhookOptions = {
  /** Destination chat accepted by this webhook. */
  chatId: string | number;
  /** Telegram webhook secret configured through setWebhook. */
  secretToken: string;
  /** Path mounted by the ChannelHost. @default "/webhooks/telegram" */
  path?: string;
};

function emptyIngressResponse(status = 200): ChannelIngressResult {
  return {
    events: [],
    response: new Response(null, { status })
  };
}

function asTelegramMessage(value: unknown): TelegramMessage | undefined {
  return value !== null && typeof value === "object"
    ? (value as TelegramMessage)
    : undefined;
}

function normalizedMessage(message: TelegramMessage): ChannelInboundMessage {
  const reply = asTelegramMessage(message.reply_to_message);
  const senderId = message.from?.id;
  const username = message.from?.username;

  return {
    type: "message",
    text: message.text as string,
    reference: String(message.message_id),
    ...(typeof reply?.message_id === "number" && {
      replyTo: {
        reference: String(reply.message_id),
        ...(typeof reply.text === "string" && { text: reply.text })
      }
    }),
    ...((typeof senderId === "number" || typeof senderId === "string") && {
      sender: {
        id: String(senderId),
        ...(typeof username === "string" && { username })
      }
    })
  };
}

function approvalResponse(
  message: TelegramMessage
): ChannelApprovalResponse | undefined {
  if (message.text !== "YES" && message.text !== "NO") return undefined;

  const reply = asTelegramMessage(message.reply_to_message);
  if (typeof reply?.message_id !== "number") return undefined;
  const interactionId =
    typeof reply.text === "string"
      ? reply.text.match(INTERACTION_MARKER)?.[1]
      : undefined;

  const senderId = message.from?.id;
  const username = message.from?.username;
  return {
    type: "approval-response",
    decision: message.text === "YES" ? "approve" : "reject",
    reference: String(message.message_id),
    ...(interactionId && { interactionId }),
    replyToReference: String(reply.message_id),
    ...((typeof senderId === "number" || typeof senderId === "string") && {
      sender: {
        id: String(senderId),
        ...(typeof username === "string" && { username })
      }
    })
  };
}

function inboundEvent(
  update: TelegramUpdate,
  chatId: string
): ChannelIngressEvent | undefined {
  const message = asTelegramMessage(update.message);
  if (
    typeof message?.message_id !== "number" ||
    typeof message.text !== "string" ||
    String(message.chat?.id) !== chatId
  ) {
    return undefined;
  }

  return approvalResponse(message) ?? normalizedMessage(message);
}

/** Create dependency-free Telegram webhook ingress for a destination chat. */
export function telegramWebhook(
  options: TelegramWebhookOptions
): ChannelIngress {
  if (!/^-?\d+$/.test(String(options.chatId))) {
    throw new Error(
      "chatId must be a numeric Telegram chat id for webhook ingress"
    );
  }
  if (!options.secretToken.trim()) {
    throw new Error(
      "secretToken is required to create Telegram webhook ingress"
    );
  }

  const chatId = String(options.chatId);
  return {
    path: options.path ?? DEFAULT_TELEGRAM_WEBHOOK_PATH,
    async receive(request) {
      if (request.method !== "POST") return emptyIngressResponse(405);
      if (
        request.headers.get("x-telegram-bot-api-secret-token") !==
        options.secretToken
      ) {
        return emptyIngressResponse(401);
      }

      let update: unknown;
      try {
        update = await request.json();
      } catch {
        return emptyIngressResponse(400);
      }
      if (update === null || typeof update !== "object") {
        return emptyIngressResponse(400);
      }

      const event = inboundEvent(update as TelegramUpdate, chatId);
      return {
        events: event ? [event] : [],
        response: new Response(null, { status: 200 })
      };
    }
  };
}

/** Create a configured Telegram Bot API Channel. */
export function telegram(options: TelegramChannelOptions): Channel {
  if (!options.botToken.trim()) {
    throw new Error("botToken is required to create a Telegram channel");
  }
  if (!String(options.chatId).trim()) {
    throw new Error("chatId is required to create a Telegram channel");
  }

  const fetch = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(
    /\/$/,
    ""
  );
  const maxLength = options.maxLength ?? TELEGRAM_MESSAGE_LIMIT;
  if (
    !Number.isInteger(maxLength) ||
    maxLength < 1 ||
    maxLength > TELEGRAM_MESSAGE_LIMIT
  ) {
    throw new Error(
      `maxLength must be an integer between 1 and ${TELEGRAM_MESSAGE_LIMIT}`
    );
  }
  const toText = options.toText ?? defaultText;
  const ingress = options.webhook
    ? telegramWebhook({ chatId: options.chatId, ...options.webhook })
    : undefined;

  async function send(
    text: string,
    parseMode?: TelegramChannelOptions["parseMode"]
  ): Promise<DeliveryResult> {
    if (text.length > maxLength) {
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "TELEGRAM_MESSAGE_TOO_LONG",
          message: `Telegram message exceeds the configured ${maxLength}-character limit`
        }
      };
    }

    let response: Response;
    try {
      response = await fetch(
        `${apiBaseUrl}/bot${options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: options.chatId,
            text,
            ...(parseMode && { parse_mode: parseMode })
          })
        }
      );
    } catch {
      return uncertain("Telegram delivery failed with an unknown outcome");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return uncertain("Telegram returned an invalid delivery response");
    }

    const apiResponse = asApiResponse(payload);
    return apiResponse
      ? classifyResponse(response, apiResponse)
      : uncertain("Telegram returned an invalid delivery response");
  }

  return {
    ...(ingress && { ingress }),
    deliver(message) {
      return send(toText(message), options.parseMode);
    },
    requestApproval({ interactionId, request }) {
      return send(approvalText(interactionId, request));
    }
  };
}
