import {
  ChannelHost,
  email,
  fallback,
  fanout,
  sharedAlarm,
  telegram,
  type Channel,
  type ChannelEmailInput,
  type ChannelMessage,
  type DurableObjectAlarmCoordinator,
  type DurableObjectAlarmSource
} from "@cloudflare/channels";
import { createChannelTool as createAiSdkChannelTool } from "@cloudflare/channels/ai-sdk";
import { createChannelTool as createTanStackChannelTool } from "@cloudflare/channels/tanstack-ai";
import { createWorkersAiChat } from "@cloudflare/tanstack-ai";
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { webhookChannel } from "./webhook-channel";

const EXAMPLE_MESSAGE: ChannelMessage = {
  title: "Import needs attention",
  markdown: "The customer import stopped after **1,240 records**."
};

const EVENT_PREFIX = "example:event:";

type ExampleEvent = {
  at: string;
  kind: "alarm" | "approval" | "message";
  value: unknown;
};

export class ChannelsExample extends DurableObject<Env> {
  readonly #supportChat: Channel;
  readonly #resilientSupport: Channel;
  readonly #fanoutSupport: Channel;
  readonly #operationsWebhook: Channel;
  readonly #host: ChannelHost;
  readonly #alarms: DurableObjectAlarmCoordinator;
  readonly #applicationAlarms: DurableObjectAlarmSource;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.#supportChat = telegram({
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_SUPPORT_CHAT_ID,
      webhook: {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET
      }
    });

    const supportEmail = email({
      binding: env.EMAIL,
      from: env.EMAIL_FROM,
      to: env.SUPPORT_EMAIL
    });

    this.#resilientSupport = fallback([this.#supportChat, supportEmail]);
    this.#fanoutSupport = fanout([this.#supportChat, supportEmail]);
    this.#operationsWebhook = webhookChannel(env.OPERATIONS_WEBHOOK_URL);

    this.#alarms = sharedAlarm(ctx.storage);
    this.#applicationAlarms = this.#alarms.source("application");
    this.#host = new ChannelHost({
      storage: ctx.storage,
      scheduler: this.#alarms.source("channels"),
      channels: {
        supportChat: this.#supportChat,
        supportEmail,
        resilientSupport: this.#resilientSupport,
        operationsWebhook: this.#operationsWebhook
      },
      approvalRequests: "operationsWebhook",
      delivery: "resilientSupport",
      publicBaseUrl: env.PUBLIC_BASE_URL,
      onMessage: ({ channelId, message }) =>
        this.#record(
          "message",
          { channelId, message },
          `${channelId}:${message.reference}`
        ),
      onApprovalResponse: (event) =>
        this.#record("approval", event, event.interactionId)
    });

    ctx.blockConcurrencyWhile(() => this.#host.init());
  }

  override async fetch(request: Request): Promise<Response> {
    const ingressResponse = await this.#host.handleRequest(request);
    if (ingressResponse) return ingressResponse;

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        routes: {
          directTelegram: "POST /direct/telegram",
          directFallback: "POST /direct/fallback",
          directFanout: "POST /direct/fanout",
          directCustom: "POST /direct/custom",
          durable: "POST /durable?deliveryId=import-alert-2026-08-17",
          approval:
            "POST /approval?interactionId=deploy-42&channel=operationsWebhook",
          aiSdk: "POST /ai-sdk",
          tanstackAi: "POST /tanstack-ai",
          applicationAlarm: "POST /application-alarm",
          events: "GET /events",
          telegramWebhook: "/webhooks/telegram"
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/direct/telegram") {
      return Response.json(await this.#supportChat.deliver(EXAMPLE_MESSAGE));
    }

    if (request.method === "POST" && url.pathname === "/direct/fallback") {
      return Response.json(
        await this.#resilientSupport.deliver(EXAMPLE_MESSAGE)
      );
    }

    if (request.method === "POST" && url.pathname === "/direct/fanout") {
      return Response.json(await this.#fanoutSupport.deliver(EXAMPLE_MESSAGE));
    }

    if (request.method === "POST" && url.pathname === "/direct/custom") {
      return Response.json(
        await this.#operationsWebhook.deliver(EXAMPLE_MESSAGE)
      );
    }

    if (request.method === "POST" && url.pathname === "/durable") {
      return Response.json(
        await this.#host.deliver({
          deliveryId:
            url.searchParams.get("deliveryId") ?? "import-alert-2026-08-17",
          message: EXAMPLE_MESSAGE
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/approval") {
      const channelId = url.searchParams.get("channel") ?? "operationsWebhook";
      if (
        channelId !== "supportChat" &&
        channelId !== "supportEmail" &&
        channelId !== "operationsWebhook"
      ) {
        return Response.json(
          {
            error:
              "channel must be supportChat, supportEmail, or operationsWebhook"
          },
          { status: 400 }
        );
      }

      await this.#host.setApprovalRequestsChannel(channelId);
      return Response.json(
        await this.#host.requestApproval({
          interactionId: url.searchParams.get("interactionId") ?? "deploy-42",
          request: {
            title: "Production deployment",
            summary: "Deploy version 2026.08.17 to production?",
            input: {
              version: "2026.08.17",
              environment: "production"
            }
          }
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/ai-sdk") {
      const workersai = createWorkersAI({ binding: this.env.AI });
      const result = await generateText({
        model: workersai("@cf/moonshotai/kimi-k2.7-code"),
        prompt:
          "An import stopped after 1,240 records. You must notify support, then summarize what you did.",
        tools: {
          contactSupport: createAiSdkChannelTool(this.#resilientSupport, {
            description: "Contact support when a person needs to intervene"
          })
        },
        stopWhen: stepCountIs(2)
      });
      return Response.json({ text: result.text });
    }

    if (request.method === "POST" && url.pathname === "/tanstack-ai") {
      const stream = chat({
        adapter: createWorkersAiChat(
          "@cf/meta/llama-4-scout-17b-16e-instruct",
          { binding: this.env.AI }
        ),
        messages: [
          {
            role: "user",
            content:
              "The import failed. You must notify support and tell me what you did."
          }
        ],
        tools: [
          createTanStackChannelTool(this.#host, {
            name: "contact_support",
            description: "Contact support when a person needs to intervene"
          })
        ]
      });
      return toServerSentEventsResponse(stream);
    }

    if (request.method === "POST" && url.pathname === "/application-alarm") {
      const alarmId = crypto.randomUUID();
      await this.#applicationAlarms.schedule(alarmId, Date.now() + 1_000);
      return Response.json({ alarmId, scheduledInMs: 1_000 });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const events = await this.ctx.storage.list<ExampleEvent>({
        prefix: EVENT_PREFIX
      });
      return Response.json([...events.values()]);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleEmail(input: ChannelEmailInput): Promise<boolean> {
    return this.#host.handleEmail(input);
  }

  override async alarm(): Promise<void> {
    await this.#alarms.handleAlarm({
      channels: this.#host.handleAlarm,
      application: async (alarmIds) => {
        for (const alarmId of alarmIds) {
          await this.#record("alarm", { alarmId }, alarmId);
        }
      }
    });
  }

  async #record(
    kind: ExampleEvent["kind"],
    value: unknown,
    id: string
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.ctx.storage.put(
      `${EVENT_PREFIX}${kind}:${encodeURIComponent(id)}`,
      {
        at,
        kind,
        value
      } satisfies ExampleEvent
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/operations-webhook") {
      const message = (await request.json()) as unknown;
      console.log("Operations webhook received", message);
      return Response.json(
        { accepted: true },
        { headers: { "x-message-id": crypto.randomUUID() } }
      );
    }

    return env.CHANNELS_EXAMPLE.getByName("default").fetch(request);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await env.CHANNELS_EXAMPLE.getByName("default").handleEmail(message);
  }
} satisfies ExportedHandler<Env>;
