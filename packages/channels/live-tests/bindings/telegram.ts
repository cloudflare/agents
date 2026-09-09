import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { telegram } from "../../src/adapters/telegram";
import type { ChannelMessageSurface } from "../../src/surface";
import { ChannelHost } from "../../src/host";
import {
  requiredEnv,
  type LiveDeliveryBinding,
  type ObservedMessage
} from "../binding";

const creationActions = new Set([
  "MessageActionChannelCreate",
  "MessageActionChatCreate"
]);

/** The raw MTProto update that carries a bot's draft to the reader's client. */
type TypingUpdate = {
  className?: string;
  userId?: unknown;
  action?: { className?: string };
};

/** Recover the bot's own user id from its BotFather token prefix. */
function botUserId(botToken: string): number {
  const id = Number(botToken.match(/^(\d+):/)?.[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Could not read a bot user id from the Telegram bot token");
  }
  return id;
}

export function telegramBinding(): LiveDeliveryBinding {
  const chatId = requiredEnv("CHANNELS_LIVE_TELEGRAM_CHAT_ID");
  const numericChatId = Number(chatId);
  if (!Number.isSafeInteger(numericChatId) || numericChatId <= 0) {
    throw new Error(
      "Telegram streaming live tests require a private-chat user ID; groups and channels discard sendMessageDraft previews"
    );
  }
  const botToken = requiredEnv("CHANNELS_LIVE_TELEGRAM_BOT_TOKEN");
  /**
   * The two sides of a direct message address it by different ids: the bot
   * sends to the user's id, while the observing user session reads the chat
   * named by the bot's id. They coincide only for groups and channels.
   *
   * Getting this wrong is destructive rather than merely wrong, because the
   * user's own id names Saved Messages, and `clear()` revokes everything it
   * finds. `open()` refuses to proceed unless the target is the intended one.
   */
  const observedChatId = botUserId(botToken);
  const client = new TelegramClient(
    new StringSession(requiredEnv("CHANNELS_LIVE_TELEGRAM_SESSION")),
    Number(requiredEnv("CHANNELS_LIVE_TELEGRAM_API_ID")),
    requiredEnv("CHANNELS_LIVE_TELEGRAM_API_HASH"),
    { connectionRetries: 3 }
  );
  const channel = telegram({ botToken });
  const botId = botUserId(botToken);
  // Telegram surfaces a bot's draft to the recipient's client as a typing
  // update with its own action, distinct from an ordinary typing indicator.
  // Counting those is the only positive evidence available that a preview
  // reached the reader, since the Bot API cannot read back its own draft.
  let previews = 0;
  const host = new ChannelHost({ channels: { telegram: channel } });
  const surface: ChannelMessageSurface = {
    channelKey: "telegram",
    version: 1,
    address: { chatId },
    label: `Telegram · ${chatId}`
  };

  async function messages() {
    return Array.from(
      await client.getMessages(observedChatId, { limit: undefined })
    );
  }

  function isCreationMessage(
    message: Awaited<ReturnType<typeof messages>>[number]
  ) {
    return creationActions.has(message.action?.className ?? "");
  }

  async function clear(): Promise<void> {
    const deletable = (await messages()).filter(
      (message) => !isCreationMessage(message)
    );
    if (deletable.length > 0) {
      await client.deleteMessages(observedChatId, deletable, {
        revoke: true
      });
    }
  }

  return {
    name: "telegram",
    host,
    surface,
    destination: `Telegram chat ${chatId}`,
    async open() {
      await client.connect();
      client.addEventHandler((update: TypingUpdate) => {
        if (
          update?.className === "UpdateUserTyping" &&
          update.action?.className === "SendMessageTextDraftAction" &&
          Number(update.userId) === botId
        ) {
          previews += 1;
        }
      });
      await client.getDialogs({ folder: 0 });
      const sessionUserId = Number((await client.getMe()).id);
      if (observedChatId === sessionUserId) {
        throw new Error(
          "Refusing to run: the observed chat is this account's Saved Messages, whose contents clear() would revoke"
        );
      }
      if (numericChatId !== sessionUserId) {
        throw new Error(
          `Refusing to run: the bot would send to user ${numericChatId}, but the observing session is user ${sessionUserId}, so the test would read a different conversation`
        );
      }
      await client.getEntity(observedChatId);
      await clear();
      previews = 0;
    },
    clear,
    previews: () => previews,
    async read(): Promise<ObservedMessage[]> {
      return (await messages()).flatMap((message) =>
        typeof message.message === "string" ? [{ text: message.message }] : []
      );
    },
    async close() {
      await client.disconnect();
    }
  };
}
