/**
 * Forever Chat — Durable AI streaming with multi-provider recovery.
 *
 * Demonstrates three recovery strategies after DO eviction:
 * - Workers AI: persist partial + inline continuation via continueLastTurn()
 * - OpenAI: retrieve completed response via Responses API (store: true)
 * - Anthropic: persist partial + continue via synthetic user message
 *              (no prefill support, reasoning disabled for recovery)
 *
 * Uses the withDurableChat mixin for automatic keepAlive during
 * streaming and onChatRecovery for provider-specific recovery.
 */
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  withDurableChat,
  type ChatRecoveryContext,
  type ChatRecoveryOptions
} from "@cloudflare/ai-chat/experimental/forever";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────

type Provider = "workersai" | "openai" | "anthropic";

type AgentState = {
  lastProvider?: Provider;
};

// ── Tools ─────────────────────────────────────────────────────────────

const chatTools = {
  getWeather: tool({
    description: "Get the current weather for a city",
    inputSchema: z.object({
      city: z.string().describe("City name")
    }),
    execute: async ({ city }) => {
      const conditions = ["sunny", "cloudy", "rainy", "snowy"];
      const temp = Math.floor(Math.random() * 30) + 5;
      return {
        city,
        temperature: temp,
        condition: conditions[Math.floor(Math.random() * conditions.length)],
        unit: "celsius"
      };
    }
  }),

  getUserTimezone: tool({
    description:
      "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
    inputSchema: z.object({})
  }),

  calculate: tool({
    description:
      "Perform a math calculation with two numbers. Requires approval for large numbers.",
    inputSchema: z.object({
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
      operator: z
        .enum(["+", "-", "*", "/", "%"])
        .describe("Arithmetic operator")
    }),
    needsApproval: async ({ a, b }) => Math.abs(a) > 1000 || Math.abs(b) > 1000,
    execute: async ({ a, b, operator }) => {
      const ops: Record<string, (x: number, y: number) => number> = {
        "+": (x, y) => x + y,
        "-": (x, y) => x - y,
        "*": (x, y) => x * y,
        "/": (x, y) => x / y,
        "%": (x, y) => x % y
      };
      if (operator === "/" && b === 0) return { error: "Division by zero" };
      return {
        expression: `${a} ${operator} ${b}`,
        result: ops[operator](a, b)
      };
    }
  })
};

const SYSTEM_PROMPT =
  "You are a helpful assistant running as a durable agent. " +
  "If your last response appears to be cut off or incomplete, " +
  "seamlessly continue from exactly where it ended — " +
  "do not repeat any text, just pick up mid-sentence or mid-paragraph. " +
  "You can check the weather and perform calculations. " +
  "For calculations with large numbers (over 1000), you need user approval first.";

// ── Agent ─────────────────────────────────────────────────────────────

const DurableChatAgent = withDurableChat(AIChatAgent);

export class ForeverChatAgent extends DurableChatAgent<Env, AgentState> {
  maxPersistedMessages = 200;

  // ── Recovery ────────────────────────────────────────────────────

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    const provider = this.state?.lastProvider;

    // Anthropic doesn't support assistant prefill, so continueLastTurn()
    // won't work (it sends the conversation ending with the partial
    // assistant message). Schedule a saveMessages with a user prompt instead.
    if (provider === "anthropic") {
      await this.schedule(0, "_continueWithUserMessage", undefined, {
        idempotent: true
      });
      return { continue: false };
    }

    if (provider !== "openai") return {};

    // OpenAI Responses API: the generation continues server-side even
    // after our connection drops. Retrieve the completed response by ID.
    const responseId = this._getStoredResponseId();
    if (!responseId) return {};

    try {
      const res = await fetch(
        `https://api.openai.com/v1/responses/${responseId}`,
        { headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` } }
      );
      if (!res.ok) return {};

      const data = (await res.json()) as {
        status: string;
        output: Array<{
          type: string;
          content: Array<{ type: string; text: string }>;
        }>;
      };
      if (data.status !== "completed") return {};

      const text = data.output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content)
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
      if (!text) return {};

      // Persist the partial to establish the message ID from chunks,
      // then replace with the complete retrieved response
      this._persistOrphanedStream(ctx.streamId);
      const lastAssistant = [...this.messages]
        .reverse()
        .find((m) => m.role === "assistant");

      if (lastAssistant) {
        lastAssistant.parts = [{ type: "text" as const, text }];
        await this.persistMessages([...this.messages]);
      }

      return { persist: false, continue: false };
    } catch (e) {
      console.error("[ForeverChat] OpenAI retrieval failed:", e);
      return {};
    }
  }

  async _continueWithUserMessage() {
    const ready = await this.waitUntilStable({ timeout: 10_000 });
    if (!ready) return;

    // Pass recovering flag so onChatMessage can disable reasoning
    this._lastBody = { ...this._lastBody, recovering: true };
    await this.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [
          {
            type: "text" as const,
            text: "Your previous response was interrupted. Please continue exactly where you left off."
          }
        ],
        metadata: { synthetic: true }
      }
    ]);
  }

  // ── Chat ────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const provider = (options?.body?.provider as Provider) ?? "workersai";
    this.setState({ ...this.state, lastProvider: provider });

    const recovering = !!options?.body?.recovering;
    const providerConfig = this._getProviderConfig(provider, recovering);

    const result = streamText({
      model: this._getModel(provider),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: chatTools,
      stopWhen: stepCountIs(5),
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- provider-specific options
      providerOptions: providerConfig.providerOptions as any,
      includeRawChunks: providerConfig.includeRawChunks,
      onChunk: providerConfig.onChunk
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Provider setup ──────────────────────────────────────────────

  private _getModel(provider: Provider) {
    switch (provider) {
      case "openai":
        return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })("gpt-5.4");
      case "anthropic":
        return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })(
          "claude-sonnet-4-6"
        );
      default:
        return createWorkersAI({ binding: this.env.AI })(
          "@cf/moonshotai/kimi-k2.5",
          { sessionAffinity: this.sessionAffinity }
        );
    }
  }

  private _getProviderConfig(
    provider: Provider,
    recovering = false
  ): {
    providerOptions?: Record<string, Record<string, unknown>>;
    includeRawChunks?: boolean;
    onChunk?: (event: { chunk: { type: string; rawValue?: unknown } }) => void;
  } {
    if (provider === "openai") {
      return {
        providerOptions: {
          openai: {
            store: true,
            reasoningEffort: "low",
            reasoningSummary: "auto"
          }
        },
        includeRawChunks: true,
        onChunk: ({ chunk }) => {
          if (chunk.type !== "raw") return;
          const raw = chunk.rawValue as
            | { type?: string; response?: { id?: string } }
            | undefined;
          if (raw?.type === "response.created" && raw.response?.id) {
            this._storeResponseId(raw.response.id);
          }
        }
      };
    }
    if (provider === "anthropic") {
      return {
        providerOptions: {
          anthropic: recovering
            ? { thinking: { type: "disabled" } }
            : { thinking: { type: "adaptive" } }
        }
      };
    }
    return {};
  }

  // ── OpenAI response ID persistence ─────────────────────────────

  private _storeResponseId(id: string) {
    this.sql`
      INSERT OR REPLACE INTO cf_ai_chat_request_context (key, value)
      VALUES ('openaiResponseId', ${id})
    `;
  }

  private _getStoredResponseId(): string | undefined {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM cf_ai_chat_request_context
      WHERE key = 'openaiResponseId'
    `;
    return rows?.[0]?.value;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
