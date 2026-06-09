import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { TelegramAdapterConfig } from "@chat-adapter/telegram";
import type { TextStreamCallback } from "./delivery";
import type { ChatSdkMessengerOptions, MessengerDefinition } from "./chat-sdk";
import { chatSdkMessenger } from "./chat-sdk";

export const TELEGRAM_STREAM_SOFT_LIMIT = 3_400;
export const TELEGRAM_FOLLOWUP_CHUNK_LIMIT = 3_500;

const TELEGRAM_DEDUPE_PREFIX = "dedupe:telegram:";

export interface TelegramMessengerOptions extends Omit<
  ChatSdkMessengerOptions,
  "adapter" | "provider" | "userName" | "verifyWebhook"
> {
  apiBaseUrl?: string;
  apiUrl?: string;
  mode?: TelegramAdapterConfig["mode"];
  secretToken?: string;
  token: string;
  userName: string;
  verifyWebhook?:
    | false
    | ((request: Request) => boolean | Response | Promise<boolean | Response>);
}

export function telegramMessenger(
  options: TelegramMessengerOptions
): MessengerDefinition {
  const adapterName = options.adapterName ?? "telegram";
  const shardThread =
    options.shardKey ??
    ((threadId: string) => defaultTelegramThreadShard(threadId, adapterName));

  if (
    (options.mode ?? "webhook") === "webhook" &&
    !options.secretToken &&
    options.verifyWebhook === undefined
  ) {
    throw new Error(
      "telegramMessenger requires secretToken for webhook verification, or verifyWebhook: false to opt out explicitly"
    );
  }

  const adapter = createTelegramAdapter({
    apiBaseUrl: options.apiBaseUrl,
    apiUrl: options.apiUrl,
    botToken: options.token,
    mode: options.mode ?? "webhook",
    secretToken: options.secretToken,
    userName: options.userName
  });

  return chatSdkMessenger({
    ...options,
    adapter,
    adapterName,
    capabilities: {
      canEditMessages: true,
      canStream: true,
      supportsActions: true,
      supportsAttachments: true,
      ...options.capabilities
    },
    delivery: {
      isExpectedDeliveryCompletion: isExpectedTelegramFinalEditNoop,
      splitText: splitTelegramMessageText,
      visibleSoftLimit: TELEGRAM_STREAM_SOFT_LIMIT,
      ...options.delivery
    },
    keyShard: (key) =>
      options.keyShard?.(key) ?? shardTelegramStateKey(key, shardThread),
    provider: "telegram",
    shardKey: shardThread,
    userName: options.userName,
    verifyWebhook:
      options.verifyWebhook === false
        ? false
        : (options.verifyWebhook ??
          telegramSecretTokenVerifier(options.secretToken))
  });
}

export default telegramMessenger;

export function telegramSecretTokenVerifier(
  secretToken: string | undefined
): (request: Request) => boolean {
  if (!secretToken) {
    throw new Error("Telegram webhook secretToken is required");
  }

  return (request) =>
    request.headers.get("x-telegram-bot-api-secret-token") === secretToken;
}

export function defaultTelegramThreadShard(
  threadId: string,
  adapterName = "telegram"
): string {
  const shard = threadId.split(":").slice(0, 2).join(":") || "telegram";
  return adapterName === "telegram" ? shard : `${adapterName}:${shard}`;
}

export function shardTelegramStateKey(
  key: string,
  shardThread: (threadId: string) => string = defaultTelegramThreadShard
): string | undefined {
  if (!key.startsWith(TELEGRAM_DEDUPE_PREFIX)) {
    return undefined;
  }

  const chatId = key.slice(TELEGRAM_DEDUPE_PREFIX.length).split(":")[0];
  return chatId ? shardThread(`telegram:${chatId}`) : undefined;
}

export function isTelegramIgnorableDeliveryError(error: unknown): boolean {
  if (error === undefined || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : String(error).toLowerCase();

  return (
    code === "VALIDATION_ERROR" && message.includes("message is not modified")
  );
}

export function isExpectedTelegramFinalEditNoop(
  error: unknown,
  callback: Pick<TextStreamCallback, "visibleLimitReached">
): boolean {
  return (
    callback.visibleLimitReached() && isTelegramIgnorableDeliveryError(error)
  );
}

export function splitTelegramMessageText(
  text: string,
  limit = TELEGRAM_FOLLOWUP_CHUNK_LIMIT
): string[] {
  if (!text.trim()) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
