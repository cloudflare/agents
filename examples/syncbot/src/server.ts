import { Agent, routeAgentRequest, getAgentByName, callable } from "agents";
import { SlackMessenger } from "@cloudflare/messengers/slack";
import { TelegramMessenger } from "@cloudflare/messengers/telegram";
import { teeAsyncIterable } from "@cloudflare/messengers";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type {
  InboundEvent,
  ChannelRef,
  MessengerAdapter
} from "@cloudflare/messengers";

const SYSTEM_PROMPT = `You are a helpful AI assistant available on multiple platforms. Keep responses concise and well-formatted. Be friendly and direct. Do not mention which platform you are running on.`;

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  author: string;
  platform: string;
  timestamp: number;
}

interface ChannelRecord {
  ref: string;
  platform: string;
}

interface BotState {
  messageCount: number;
  lastActivity: number;
  platforms: string[];
}

function env(obj: object, key: string): string | undefined {
  return key in obj ? String((obj as Record<string, unknown>)[key]) : undefined;
}

export class SyncBot extends Agent<Env, BotState> {
  // Adapters are initialized only when credentials are present.
  // To enable a platform, set its env vars. To disable, remove them.
  slack = env(this.env, "SLACK_BOT_TOKEN")
    ? new SlackMessenger({
        botToken: this.env.SLACK_BOT_TOKEN,
        signingSecret: this.env.SLACK_SIGNING_SECRET
      })
    : undefined;

  telegram = env(this.env, "TELEGRAM_BOT_TOKEN")
    ? new TelegramMessenger({
        botToken: this.env.TELEGRAM_BOT_TOKEN,
        secretToken: env(this.env, "TELEGRAM_WEBHOOK_SECRET")
      })
    : undefined;

  #ai = createWorkersAI({ binding: this.env.AI });

  initialState: BotState = {
    messageCount: 0,
    lastActivity: 0,
    platforms: []
  };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      platform TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS channels (
      ref TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      added_at INTEGER NOT NULL
    )`;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");

    if (platform === "slack" && this.slack) {
      return this.slack.handleWebhook(request, (event) =>
        this.handleIncoming(event)
      );
    }
    if (platform === "telegram" && this.telegram) {
      return this.telegram.handleWebhook(request, (event) =>
        this.handleIncoming(event)
      );
    }

    return new Response("Unknown platform", { status: 400 });
  }

  private async handleIncoming(event: InboundEvent) {
    if (event.type !== "message") return;
    if (event.message.author.isBot) return;

    this.registerChannel(event.channel);

    const authorLabel = `${event.message.author.name} (${event.platform})`;

    this.sql`INSERT INTO messages (role, content, author, platform, timestamp)
             VALUES ('user', ${event.message.text}, ${authorLabel}, ${event.platform}, ${Date.now()})`;

    this.setState({
      messageCount: (this.state.messageCount ?? 0) + 1,
      lastActivity: Date.now(),
      platforms: this.getActivePlatforms()
    });

    const history = [
      ...this.sql<StoredMessage>`
        SELECT role, content FROM messages
        ORDER BY timestamp ASC
        LIMIT 20
      `
    ];

    try {
      const result = streamText({
        model: this.#ai("@cf/moonshotai/kimi-k2.5", {
          sessionAffinity: this.sessionAffinity
        }),
        system: SYSTEM_PROMPT,
        messages: history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        }))
      });

      const text = await this.fanOut(result.textStream, event.channel);

      this.sql`INSERT INTO messages (role, content, author, platform, timestamp)
               VALUES ('assistant', ${text}, 'bot', 'all', ${Date.now()})`;
    } catch (err) {
      console.error("Failed to generate response:", err);
      await this.postToChannel(
        event.channel,
        "Sorry, I ran into an error. Please try again."
      );
    }
  }

  private async fanOut(
    textStream: AsyncIterable<string>,
    source: ChannelRef
  ): Promise<string> {
    const otherChannels = this.getOtherChannels(source);

    const { streams, collected } = teeAsyncIterable(textStream, 1);

    const sourceAdapter = this.adapterFor(source);
    if (sourceAdapter) {
      await sourceAdapter.streamMessage(source, streams[0]);
    } else {
      for await (const _ of streams[0]) {
        /* drain */
      }
    }

    const fullText = await collected;

    await Promise.allSettled(
      otherChannels.map(async (channel) => {
        try {
          await this.postToChannel(channel, fullText);
        } catch (err) {
          console.error(`Failed to post to ${channel.platform}:`, err);
        }
      })
    );

    return fullText;
  }

  private adapterFor(channel: ChannelRef): MessengerAdapter | undefined {
    if (channel.platform === "slack") return this.slack;
    if (channel.platform === "telegram") return this.telegram;
    return undefined;
  }

  private async postToChannel(channel: ChannelRef, text: string) {
    const adapter = this.adapterFor(channel);
    if (adapter) {
      await adapter.postMessage(channel, { markdown: text });
    }
  }

  private getOtherChannels(source: ChannelRef): ChannelRef[] {
    const sourceRef = JSON.stringify(source);
    const all = [...this.sql<ChannelRecord>`SELECT ref FROM channels`];
    return all
      .filter((ch) => ch.ref !== sourceRef)
      .map((ch) => JSON.parse(ch.ref) as ChannelRef);
  }

  private registerChannel(channel: ChannelRef) {
    const ref = JSON.stringify(channel);
    const existing = [...this.sql`SELECT ref FROM channels WHERE ref = ${ref}`];
    if (existing.length === 0) {
      this.sql`INSERT INTO channels (ref, platform, added_at)
               VALUES (${ref}, ${channel.platform}, ${Date.now()})`;
    }
  }

  private getActivePlatforms(): string[] {
    return [
      ...this.sql<{ platform: string }>`
        SELECT DISTINCT platform FROM channels
      `
    ].map((r) => r.platform);
  }

  @callable()
  getRecentMessages(limit = 50) {
    return [
      ...this.sql<StoredMessage>`
        SELECT role, content, author, platform, timestamp FROM messages
        ORDER BY timestamp DESC LIMIT ${limit}
      `
    ].reverse();
  }

  @callable()
  getStats() {
    const total =
      this.sql<{ count: number }>`SELECT COUNT(*) as count FROM messages`[0]
        ?.count ?? 0;
    const channels = [
      ...this.sql<ChannelRecord>`SELECT ref, platform FROM channels`
    ];
    return {
      totalMessages: total,
      channels: channels.map((c) => c.platform),
      ...this.state
    };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/slack/events" && request.method === "POST") {
      const body = await request.clone().json<Record<string, unknown>>();

      if (body.type === "url_verification") {
        return new Response(JSON.stringify({ challenge: body.challenge }), {
          headers: { "content-type": "application/json" }
        });
      }

      const agent = await getAgentByName(env.SyncBot, "default");
      const forwarded = new Request(
        url.origin + "/webhook?platform=slack",
        request
      );
      return agent.fetch(forwarded);
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const agent = await getAgentByName(env.SyncBot, "default");
      const forwarded = new Request(
        url.origin + "/webhook?platform=telegram",
        request
      );
      return agent.fetch(forwarded);
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
