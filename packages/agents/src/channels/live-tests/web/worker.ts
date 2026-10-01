import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import {
  ChannelHost,
  type ChannelChunk,
  type ChannelConversationChunk,
  type ChannelConversationMessage,
  type ChannelDeliveryOptions,
  type ChannelMessage,
  type ChannelMessageSurface,
  type ChannelStreamOptions,
  type DeliveryResult
} from "agents/channels";
import { web } from "agents/channels/web";
import { WEB_CHANNEL_DEMO_HTML } from "./demo-page";

type Env = {
  WEB_CHANNEL_LIVE: DurableObjectNamespace<WebChannelLiveObject>;
  LIVE_TEST_TOKEN?: string;
};

type StreamSession = {
  controller: ReadableStreamDefaultController<ChannelChunk>;
  delivery: Promise<DeliveryResult>;
};

type DemoRoute =
  | "capture"
  | "rich"
  | "rich-interrupted"
  | "client-tool"
  | "approval"
  | "eviction-terminal";

const DEMO_CHUNKS: readonly ChannelChunk[] = [
  { type: "reasoning", text: "Inspecting a deterministic demo request. " },
  { type: "reasoning", text: "No model or external service is involved." },
  { type: "text", text: "The Web Channel is streaming " },
  { type: "text", text: "reasoning, text, and a source over one WebSocket." },
  {
    type: "source",
    url: "https://developers.cloudflare.com/agents/",
    title: "Cloudflare Agents documentation"
  }
];

const DEMO_CHUNK_DELAY_MS = 450;

function historyKey(conversationId: string): string {
  return `conversation:${conversationId}:messages`;
}

function initialHistory(): ChannelConversationMessage[] {
  return [
    {
      id: "prior-user",
      author: { type: "participant", participantId: "prior-member" },
      content: [{ type: "text", text: "Prior canonical question" }]
    },
    {
      id: "prior-assistant",
      author: { type: "agent" },
      content: [{ type: "text", text: "Prior canonical answer" }]
    }
  ];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function streamOf(
  chunks: readonly ChannelChunk[]
): ReadableStream<ChannelChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

class WebLiveControl extends RpcTarget {
  readonly #streams = new Map<string, StreamSession>();
  readonly #storage: DurableObjectStorage;
  readonly #host: () => ChannelHost;

  constructor(storage: DurableObjectStorage, host: () => ChannelHost) {
    super();
    this.#storage = storage;
    this.#host = host;
  }

  async surface(): Promise<ChannelMessageSurface | null> {
    return (await this.#storage.get<ChannelMessageSurface>("surface")) ?? null;
  }

  async toolResultCount(): Promise<number> {
    return (await this.#storage.get<number>("tool-result-count")) ?? 0;
  }

  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult> {
    return this.#host().deliver(surface, message, options);
  }

  startStream(
    surface: ChannelMessageSurface,
    options?: ChannelStreamOptions
  ): { id: string } {
    const id = crypto.randomUUID();
    let controller!: ReadableStreamDefaultController<ChannelChunk>;
    const chunks = new ReadableStream<ChannelChunk>({
      start(streamController) {
        controller = streamController;
      }
    });
    const address = surface.address as { conversationId?: unknown } | null;
    const conversationId =
      typeof address?.conversationId === "string"
        ? address.conversationId
        : "live-control";
    const delivery = this.#host().stream(surface, chunks, {
      ...options,
      response: options?.response ?? {
        id: `live-control-response:${id}`,
        conversationId,
        messageId: `live-control-message:${id}`
      }
    });
    this.#streams.set(id, { controller, delivery });
    return { id };
  }

  push(id: string, chunk: ChannelChunk): void {
    this.#session(id).controller.enqueue(chunk);
  }

  async finish(id: string): Promise<DeliveryResult> {
    const session = this.#session(id);
    session.controller.close();
    try {
      return await session.delivery;
    } finally {
      this.#streams.delete(id);
    }
  }

  async fail(id: string, reason: string): Promise<DeliveryResult> {
    const session = this.#session(id);
    session.controller.error(new Error(reason));
    try {
      return await session.delivery;
    } finally {
      this.#streams.delete(id);
    }
  }

  async clear(): Promise<void> {
    const deliveries: Promise<DeliveryResult>[] = [];
    for (const session of this.#streams.values()) {
      session.controller.error(new Error("Live-test destination cleared"));
      deliveries.push(session.delivery);
    }
    this.#streams.clear();
    await this.#storage.delete(["surface", "tool-result-count"]);
    await Promise.allSettled(deliveries);
  }

  #session(id: string): StreamSession {
    const session = this.#streams.get(id);
    if (!session) throw new Error(`Unknown Web live-test stream ${id}`);
    return session;
  }
}

/** Bare Durable Object serving the live Web Channel contract fixture. */
export class WebChannelLiveObject extends DurableObject<Env> {
  readonly #streams = new Streams();
  readonly #control = new WebLiveControl(this.ctx.storage, () => this.#host);
  readonly #web = web({
    resolveIdentity(request) {
      const url = new URL(request.url);
      const conversationId =
        url.searchParams.get("conversationId") ?? "default-conversation";
      return {
        conversationId,
        participantId: url.searchParams.get("participantId") ?? conversationId
      };
    },
    route: (_event, ingress) => {
      if ("type" in ingress && ingress.type === "tool-result") {
        return "client-tool";
      }
      if (!("body" in ingress)) return "capture";
      if (ingress.body.demo === "client-tool") return "client-tool";
      if (ingress.body.demo === "approval") return "approval";
      if (ingress.body.demo === "eviction-terminal") {
        return "eviction-terminal";
      }
      if (ingress.body.demo !== "rich") return "capture";
      return ingress.body.interrupt === true ? "rich-interrupted" : "rich";
    },
    webSockets: { callables: this.#control }
  });
  readonly #host = new ChannelHost({
    channels: { web: this.#web },
    streams: this.#streams,
    resolveMessages: async ({ conversationId }) => ({
      messages:
        (await this.ctx.storage.get<ChannelConversationMessage[]>(
          historyKey(conversationId)
        )) ?? initialHistory()
    }),
    onMessage: async ({ message, route }) => {
      if (!message.replySurface) {
        throw new Error(
          "Web live-test message did not include a reply surface"
        );
      }
      await this.ctx.storage.put("surface", message.replySurface);
      const conversationId = message.thread.id;
      const key = historyKey(conversationId);
      const history =
        (await this.ctx.storage.get<ChannelConversationMessage[]>(key)) ??
        initialHistory();
      if (!history.some((entry) => entry.id === message.message.id)) {
        history.push({
          id: message.message.id,
          author: {
            type: "participant",
            participantId: message.actor?.id ?? "unknown-participant"
          },
          content: [{ type: "text", text: message.message.text }]
        });
        await this.ctx.storage.put(key, history);
      }

      const demoRoute = route as DemoRoute;
      if (demoRoute === "capture") return;
      if (demoRoute === "eviction-terminal") {
        const assistantId = `assistant:${message.message.id}`;
        await this.#host.stream(
          message.replySurface,
          streamOf([
            { type: "message-start", messageId: assistantId },
            { type: "text", text: "Durable response after process eviction" },
            { type: "message-finish", finishReason: "stop" }
          ]),
          {
            response: {
              id: `web-response:${message.message.id}:eviction`,
              conversationId,
              messageId: assistantId
            }
          }
        );
        return;
      }
      if (demoRoute === "approval") {
        await this.#host.requestApproval(message.replySurface, {
          interactionId: `approval:${message.message.id}`,
          request: {
            title: "Deploy application",
            summary: "Approve the deterministic Web Channel operation?",
            input: { operation: "deploy" }
          }
        });
        return;
      }
      if (demoRoute === "client-tool") {
        const hasBrowserTool = message.message.clientTools?.some(
          (tool) => tool.name === "describeBrowser"
        );
        if (!hasBrowserTool) {
          throw new Error("React demo did not advertise describeBrowser");
        }
        const assistantId = `assistant:${message.message.id}`;
        const toolCallId = `describe-browser:${message.message.id}`;
        const content: ChannelConversationChunk[] = [
          { type: "text", text: "Waiting for browser context" },
          {
            type: "tool-input-available",
            toolCallId,
            toolName: "describeBrowser",
            input: { prompt: message.message.text },
            title: "Reading browser context",
            audience: {
              type: "participant",
              participantId: message.actor?.id ?? "unknown-participant"
            }
          }
        ];
        await this.#persistAssistant(conversationId, assistantId, content);
        await this.#host.stream(
          message.replySurface,
          streamOf([
            { type: "message-start", messageId: assistantId },
            ...content,
            { type: "message-finish", finishReason: "tool-calls" }
          ]),
          {
            response: {
              id: `web-response:${message.message.id}:initial`,
              conversationId,
              messageId: assistantId
            }
          }
        );
        return;
      }

      const interrupt = demoRoute === "rich-interrupted";
      const assistantId = `assistant:${message.message.id}`;
      const emitted: ChannelChunk[] = [];
      const chunks = new ReadableStream<ChannelChunk>({
        async start(controller) {
          controller.enqueue({
            type: "message-start",
            messageId: assistantId
          });
          for (const [index, chunk] of DEMO_CHUNKS.entries()) {
            await delay(DEMO_CHUNK_DELAY_MS);
            emitted.push(chunk);
            controller.enqueue(chunk);
            if (interrupt && index === 2) {
              controller.error(new Error("Intentional demo interruption"));
              return;
            }
          }
          controller.close();
        }
      });
      await this.#host.stream(message.replySurface, chunks, {
        response: {
          id: `web-response:${message.message.id}`,
          conversationId,
          messageId: assistantId
        }
      });
      if (emitted.length > 0) {
        await this.#persistAssistant(conversationId, assistantId, emitted);
      }
    },
    onCancel: async ({ request }) => {
      await this.ctx.storage.put("cancelled-operation", request.operationId);
    },
    onConversationReset: async ({ request }) => {
      await this.ctx.storage.put(historyKey(request.thread.id), []);
      const responses = await this.#streams.list({ tag: request.thread.id });
      await Promise.all(
        responses.map((response) => this.#streams.delete(response.streamId))
      );
    },
    onApprovalResponse: async ({ response }) => {
      if (!response.replySurface) return;
      const messageId = `approval-response:${response.interactionId}`;
      await this.#host.stream(
        response.replySurface,
        streamOf([
          { type: "message-start", messageId },
          {
            type: "text",
            text: `Application recorded: ${response.decision}`
          },
          { type: "message-finish", finishReason: "stop" }
        ]),
        {
          response: {
            id: `web-response:${messageId}`,
            conversationId: response.thread.id,
            messageId
          }
        }
      );
    },
    onToolResult: async ({ result, route }) => {
      const count =
        (await this.ctx.storage.get<number>("tool-result-count")) ?? 0;
      await this.ctx.storage.put("tool-result-count", count + 1);
      if (route !== "client-tool" || !result.replySurface) return;
      const summary = result.result.success
        ? JSON.stringify(result.result.output)
        : result.result.error;
      const continuation: ChannelChunk[] = [
        {
          type: "reasoning",
          text: "The browser executed the advertised tool and returned its context."
        },
        {
          type: "text",
          text: `Client tool result received: ${summary}`
        }
      ];
      const conversationId = result.thread.id;
      const assistantId = this.#assistantIdForToolCall(result.toolCallId);
      await this.#appendAssistant(conversationId, assistantId, continuation);
      await this.#host.stream(
        result.replySurface,
        streamOf([
          { type: "message-start", messageId: assistantId },
          ...continuation,
          { type: "message-finish", finishReason: "stop" }
        ]),
        {
          response: {
            id: `web-response:${result.eventId}:continuation`,
            conversationId,
            messageId: assistantId
          }
        }
      );
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.#streams)
    .use(this.#web.webSockets);

  async onRequest(request: Request): Promise<Response> {
    return (
      (await this.#host.handleRequest(request)) ??
      new Response("Not found", { status: 404 })
    );
  }

  async #persistAssistant(
    conversationId: string,
    assistantId: string,
    content: readonly ChannelChunk[]
  ): Promise<void> {
    const key = historyKey(conversationId);
    const history =
      (await this.ctx.storage.get<ChannelConversationMessage[]>(key)) ??
      initialHistory();
    const message: ChannelConversationMessage = {
      id: assistantId,
      author: { type: "agent" },
      content
    };
    const index = history.findIndex((entry) => entry.id === assistantId);
    if (index === -1) history.push(message);
    else history[index] = message;
    await this.ctx.storage.put(key, history);
  }

  async #appendAssistant(
    conversationId: string,
    assistantId: string,
    content: readonly ChannelChunk[]
  ): Promise<void> {
    const key = historyKey(conversationId);
    const history =
      (await this.ctx.storage.get<ChannelConversationMessage[]>(key)) ??
      initialHistory();
    const existing = history.find((entry) => entry.id === assistantId);
    await this.#persistAssistant(conversationId, assistantId, [
      ...(existing?.content ?? []),
      ...content
    ]);
  }

  #assistantIdForToolCall(toolCallId: string): string {
    const prefix = "describe-browser:";
    return toolCallId.startsWith(prefix)
      ? `assistant:${toolCallId.slice(prefix.length)}`
      : `assistant:${toolCallId}`;
  }
}

function localRequest(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const suppliedToken = url.searchParams.get("token");
    if (env.LIVE_TEST_TOKEN) {
      if (suppliedToken !== env.LIVE_TEST_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    } else if (!localRequest(url)) {
      return new Response("LIVE_TEST_TOKEN is not configured", { status: 503 });
    }

    if (url.pathname === "/") {
      return new Response(WEB_CHANNEL_DEMO_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    const name = url.searchParams.get("name");
    if (!name) return new Response("Missing object name", { status: 400 });
    const id = env.WEB_CHANNEL_LIVE.idFromName(name);
    return env.WEB_CHANNEL_LIVE.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;
