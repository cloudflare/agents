import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  Type
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAI } from "agents/models/pi-ai";

/**
 * The pi-ai twin of `index.ts`. Every `/pi/*` route is the AI SDK route
 * without the prefix, and takes a model the same two ways:
 *
 * - `?model=@cf/...` — Workers AI, the catalog Cloudflare keeps.
 * - `?vendor=anthropic:claude-opus-4-8` / `?vendor=openai:gpt-5-mini` — a
 *   model from that vendor's own pi-ai registry, routed through AI Gateway.
 *   No vendor id or wire format lives in `agents`.
 */
const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

const weatherParameters = Type.Object({
  city: Type.String({ description: "City name, e.g. 'Lisbon'" })
});

/** The one tool `/pi/tools` offers, so the agent loop has something to call. */
const getWeather: AgentTool<typeof weatherParameters, Record<string, never>> = {
  description: "Get the current weather for a city.",
  execute: async (_toolCallId, { city }) => ({
    content: [
      {
        text: JSON.stringify({ city, conditions: "clear", temperatureC: 21 }),
        type: "text"
      }
    ],
    details: {}
  }),
  label: "Weather",
  name: "getWeather",
  parameters: weatherParameters
};

/** `anthropic:claude-opus-4-8` / `openai:gpt-5-mini`, from pi-ai's registries. */
function vendorModel(spec: string): Model<Api> {
  const [vendor, ...rest] = spec.split(":");
  const id = rest.join(":");
  const models =
    vendor === "anthropic"
      ? anthropicProvider().getModels()
      : vendor === "openai"
        ? openaiProvider().getModels()
        : undefined;
  if (models === undefined) {
    throw new Error(`Unknown vendor "${vendor}". Use anthropic or openai.`);
  }
  const model = models.find((entry) => entry.id === id);
  if (model === undefined) {
    throw new Error(`${vendor} has no model "${id}" in pi-ai's registry.`);
  }
  return model;
}

/** What the query string asked for: a Workers AI id or a vendor model. */
function targetOf(url: URL): string | Model<Api> {
  const vendor = url.searchParams.get("vendor");
  if (vendor !== null) return vendorModel(vendor);
  return url.searchParams.get("model") ?? DEFAULT_MODEL;
}

/** How the answering model is named back to the caller. */
function nameOf(target: string | Model<Api>): string {
  return typeof target === "string" ? target : target.id;
}

function contextOf(url: URL, fallback: string): Context {
  return {
    messages: [
      {
        content: url.searchParams.get("prompt") ?? fallback,
        role: "user",
        timestamp: Date.now()
      }
    ]
  };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

/** The gateway correlation pi-ai records on the message, for the response. */
function cloudflareOf(message: AssistantMessage): unknown {
  return message.diagnostics?.find((d) => d.type === "cloudflare")?.details;
}

function replyFor(message: AssistantMessage, model: string): Response {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return Response.json(
      {
        error: message.errorMessage,
        model,
        stopReason: message.stopReason,
        diagnostics: message.diagnostics
      },
      { status: 500 }
    );
  }
  return Response.json({
    text: textOf(message),
    model: message.model,
    stopReason: message.stopReason,
    usage: message.usage,
    cloudflare: cloudflareOf(message)
  });
}

export async function handlePi(url: URL, env: Env): Promise<Response> {
  const ai = createAI({
    binding: env.AI,
    gateway: { id: "default", metadata: { app: "next-models" } }
  });

  switch (url.pathname.replace(/\/$/, "")) {
    case "/pi": {
      const target = targetOf(url);
      const message = await ai.completeSimple(
        ai(target),
        contextOf(url, "Say hello in one short sentence."),
        { maxTokens: 2048 }
      );
      return replyFor(message, nameOf(target));
    }

    case "/pi/stream": {
      const stream = ai.streamSimple(
        ai(targetOf(url)),
        contextOf(url, "Write two sentences about Durable Objects."),
        { maxTokens: 2048 }
      );
      // Text deltas only, as a plain text stream, like the AI SDK route.
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of stream) {
              if (event.type === "text_delta") {
                controller.enqueue(encoder.encode(event.delta));
              } else if (event.type === "error") {
                console.error("stream failed", event.error.errorMessage);
              }
            }
          } finally {
            controller.close();
          }
        }
      });
      return new Response(body, {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    case "/pi/tools": {
      const target = targetOf(url);
      const agent = new Agent({
        initialState: {
          model: ai(target),
          systemPrompt: "You can check the weather with the getWeather tool.",
          tools: [getWeather]
        },
        streamFn: ai.streamFn
      });
      await agent.prompt(
        url.searchParams.get("prompt") ?? "What is the weather in Lisbon?"
      );
      await agent.waitForIdle();
      const messages = agent.state.messages;
      const last = messages.at(-1);
      return Response.json({
        model: nameOf(target),
        text:
          last?.role === "assistant" ? textOf(last as AssistantMessage) : "",
        messages: messages.map((message) => {
          switch (message.role) {
            case "assistant":
              return {
                role: message.role,
                content: message.content,
                stopReason: message.stopReason,
                cloudflare: cloudflareOf(message)
              };
            case "toolResult":
              return {
                role: message.role,
                toolName: message.toolName,
                content: message.content
              };
            case "user":
              return { role: message.role, content: message.content };
            default:
              return { role: message.role };
          }
        })
      });
    }

    case "/pi/fallback": {
      // Try the vendor model first; if it fails before producing any output,
      // the Workers AI leg answers. `message.model` names the leg that
      // answered and a `cloudflare-fallback` diagnostic lists the attempts.
      const target = vendorModel(
        url.searchParams.get("vendor") ?? "openai:gpt-5-mini"
      );
      const message = await ai.completeSimple(
        ai(target, { fallback: [DEFAULT_MODEL] }),
        contextOf(url, "Say hello in one short sentence."),
        { maxTokens: 2048 }
      );
      return replyFor(message, nameOf(target));
    }

    default:
      return new Response("Not found", { status: 404 });
  }
}
