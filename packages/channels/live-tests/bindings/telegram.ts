import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { telegram } from "../../src/adapters/telegram";
import type { ChannelMessageSurface } from "../../src/surface";
import {
  requiredEnv,
  type LiveDeliveryBinding,
  type ObservedMessage
} from "../binding";

const creationActions = new Set([
  "MessageActionChannelCreate",
  "MessageActionChatCreate"
]);

export function telegramBinding(): LiveDeliveryBinding {
  const chatId = requiredEnv("CHANNELS_LIVE_TELEGRAM_CHAT_ID");
  const numericChatId = Number(chatId);
  const client = new TelegramClient(
    new StringSession(requiredEnv("CHANNELS_LIVE_TELEGRAM_SESSION")),
    Number(requiredEnv("CHANNELS_LIVE_TELEGRAM_API_ID")),
    requiredEnv("CHANNELS_LIVE_TELEGRAM_API_HASH"),
    { connectionRetries: 3 }
  );
  const channel = telegram({
    botToken: requiredEnv("CHANNELS_LIVE_TELEGRAM_BOT_TOKEN")
  });
  const surface: ChannelMessageSurface = {
    channelKey: "telegram",
    version: 1,
    address: { chatId },
    label: `Telegram · ${chatId}`
  };

  async function messages() {
    return Array.from(
      await client.getMessages(numericChatId, { limit: undefined })
    );
  }

  function isCreationMessage(
    message: Awaited<ReturnType<typeof messages>>[number]
  ) {
    return creationActions.has(message.action?.className ?? "");
  }

  return {
    name: "telegram",
    destination: `Telegram chat ${chatId}`,
    async open() {
      await client.connect();
      await client.getDialogs({ folder: 0 });
      await client.getEntity(numericChatId);
    },
    async clear() {
      const deletable = (await messages()).filter(
        (message) => !isCreationMessage(message)
      );
      if (deletable.length > 0) {
        await client.deleteMessages(numericChatId, deletable, { revoke: true });
      }
    },
    async deliver(text) {
      return await channel.deliver!(surface, { markdown: text });
    },
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
