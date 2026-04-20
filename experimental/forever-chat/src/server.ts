/**
 * Forever Chat — Durable AI streaming with multi-provider recovery.
 *
 * Demonstrates four recovery strategies after DO eviction:
 * - Inference Buffer (any provider): resume from the durable response buffer
 *   — zero wasted tokens, zero duplicate provider calls
 * - Workers AI: persist partial + continue via continueLastTurn()
 *              (text + reasoning merge into existing blocks)
 * - OpenAI: retrieve completed response via Responses API (store: true)
 * - Anthropic: persist partial + continue via synthetic user message
 *              (no prefill support, reasoning disabled for recovery)
 *
 * Uses chatRecovery for automatic keepAlive during
 * streaming and onChatRecovery for provider-specific recovery.
 */
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest } from "agents";
import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  type UIMessage
} from "ai";
import { z } from "zod";
import {
  parseProviderStream,
  type Provider,
  type ParsedToolCall
} from "./sse-parsers";
import { createReplayModel } from "./replay-model";

// ── Types ─────────────────────────────────────────────────────────────

type AgentState = {
  lastProvider?: Provider;
  useBuffer?: boolean;
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

const RECOVERY_SUFFIX =
  " Do not think or reason — continue the text output directly.";

// ── Agent ─────────────────────────────────────────────────────────────

export class ForeverChatAgent extends AIChatAgent<Env, AgentState> {
  override chatRecovery = true;
  maxPersistedMessages = 200;

  // Tracks stash data for the current buffered turn so both the custom
  // fetch and the onChunk callback can contribute to the same snapshot.
  private _bufferStash: Record<string, unknown> = {};

  // Set by _tryBufferRecovery when a streaming replay is scheduled.
  // Read by onChatMessage to detect the replay path. Using a dedicated
  // field instead of _lastBody.resumeFromBuffer avoids depending on how
  // the framework passes body through continueLastTurn.
  private _pendingBufferReplay: string | null = null;

  // ── Chat ────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const provider = (options?.body?.provider as Provider) ?? "workersai";
    this.setState({ ...this.state, lastProvider: provider });

    // Buffer streaming replay: create a replay model that reads from the
    // buffer and emits LanguageModelV3StreamPart objects. streamText
    // handles everything natively — tool execution, reasoning, UIMessage
    // conversion. Client sees tokens streaming in.
    const replayBufferId = this._pendingBufferReplay;
    if (replayBufferId) {
      this._pendingBufferReplay = null;
      console.log(`[ForeverChat] Replaying buffer ${replayBufferId}`);
      const model = createReplayModel({
        buffer: this.env.INFERENCE_BUFFER,
        bufferId: replayBufferId,
        createModel: (replayFetch) =>
          this._getReplayModel(provider, replayFetch)
      });
      const result = streamText({
        model,
        messages: pruneMessages({
          messages: await convertToModelMessages(this.messages),
          toolCalls: "before-last-2-messages",
          reasoning: "before-last-message"
        }),
        tools: chatTools,
        stopWhen: stepCountIs(5),
        abortSignal: options?.abortSignal
      });
      return result.toUIMessageStreamResponse();
    }

    const recovering = !!options?.body?.recovering;
    const useBuffer = this.state?.useBuffer === true;

    this._bufferStash = {};

    const result = streamText({
      model: this._getModel(provider, useBuffer),
      system: recovering ? SYSTEM_PROMPT + RECOVERY_SUFFIX : SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: chatTools,
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- provider-specific options
      providerOptions: this._getProviderOptions(provider, recovering) as any,
      ...this._getChunkHandlers(provider, useBuffer)
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Recovery ────────────────────────────────────────────────────

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    // Try buffer recovery first — works for any provider routed through
    // the inference buffer. If it succeeds, we're done (zero wasted tokens).
    if (this.state?.useBuffer) {
      const result = await this._tryBufferRecovery(ctx);
      if (result) return result;
    }

    return this._providerRecovery(ctx);
  }

  /**
   * Provider-specific fallback recovery (no buffer available).
   */
  private async _providerRecovery(
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

    // Workers AI: use continueLastTurn() (prefill works). Set the
    // recovering flag so onChatMessage can hint the model to skip
    // reasoning. Even if the model still reasons, the framework merges
    // reasoning into the existing block automatically.
    if (provider === "workersai" || !provider) {
      await this.schedule(0, "_continueWorkersAI", undefined, {
        idempotent: true
      });
      return { continue: false };
    }

    if (provider !== "openai") return {};

    // OpenAI Responses API: the generation continues server-side even
    // after our connection drops. Retrieve the completed response by ID
    // (stashed via this.stash() during streaming).
    return this._openAIResponsesRecovery(ctx);
  }

  private async _openAIResponsesRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    const responseId = (ctx.recoveryData as { responseId?: string } | null)
      ?.responseId;
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

      // Persist the complete response directly as a new assistant message.
      // Can't use _persistOrphanedStream here — if the DO was evicted
      // before the chunk buffer (10 chunks) was flushed to SQLite,
      // getStreamChunks() returns [] and _persistOrphanedStream is a no-op.
      this.messages.push({
        id: crypto.randomUUID(),
        role: "assistant" as const,
        parts: [{ type: "text" as const, text }]
      });
      await this.persistMessages([...this.messages]);

      return { persist: false, continue: false };
    } catch (e) {
      console.error("[ForeverChat] OpenAI retrieval failed:", e);
      return {};
    }
  }

  async _continueWorkersAI() {
    const ready = await this.waitUntilStable({ timeout: 10_000 });
    if (!ready) return;
    this._lastBody = { ...this._lastBody, recovering: true };
    await this.continueLastTurn();
  }

  async _continueWithUserMessage() {
    const ready = await this.waitUntilStable({ timeout: 10_000 });
    if (!ready) return;
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

  // ── Buffer recovery ─────────────────────────────────────────────
  //
  // On DO restart after eviction, the fiber system calls onChatRecovery.
  // If the buffer is enabled, we check the buffer status and branch:
  //
  // - streaming/completed → schedule streaming replay via onChatMessage.
  //   The SSE transformer (sse-transformer.ts) converts raw provider SSE
  //   to AI SDK format in real-time. Client sees tokens streaming in.
  //
  // - interrupted/error → parse with accumulating parsers (sse-parsers.ts),
  //   execute recoverable tool calls, persist partial, schedule continuation.
  //
  // - idle/empty → fall through to provider-specific recovery.

  /**
   * Attempt recovery from the inference buffer.
   *
   * Three outcomes:
   * - Buffer completed → persist full response, no continuation needed
   * - Buffer partial (interrupted/error) → persist what we have,
   *   schedule continueLastTurn for the remainder
   * - Buffer empty or unavailable → return null, caller falls through
   *   to provider-specific recovery
   */
  private async _tryBufferRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | null> {
    const bufferId = (ctx.recoveryData as Record<string, unknown> | null)
      ?.bufferId as string | undefined;
    if (!bufferId) return null;

    try {
      const { status, chunkCount } = await this._bufferStatus(bufferId);

      if (status === "idle" || chunkCount === 0) {
        console.log(
          `[ForeverChat] Buffer ${bufferId}: status=${status}, chunks=${chunkCount} — skipping`
        );
        return null;
      }

      if (status === "streaming" || status === "completed") {
        // Buffer is active or already finished — use the streaming replay
        // path. The transformer converts raw provider SSE → AI SDK format
        // in real-time, and _reply() broadcasts to the client as if the
        // response were arriving live from the provider.
        console.log(
          `[ForeverChat] Buffer ${bufferId}: ${status} (${chunkCount} chunks), scheduling streaming replay`
        );

        // Persist an empty assistant message so continueLastTurn has a
        // message to continue from. Without this, continueLastTurn skips
        // (it requires a last assistant message). The buffer replay will
        // fill this message with the actual content via _reply().
        this.messages.push({
          id: crypto.randomUUID(),
          role: "assistant" as const,
          parts: []
        });
        await this.persistMessages([...this.messages]);

        this._pendingBufferReplay = bufferId;
        return { persist: false, continue: true };
      }

      // Buffer interrupted or errored — provider connection is dead.
      // Parse what we have and persist. Use the accumulating parsers
      // (not the streaming transformer) because we need to extract
      // tool calls and execute them during recovery.
      const rawSSE = await this._readBuffer(bufferId, false);
      const provider = this.state?.lastProvider ?? "workersai";
      const parsed = parseProviderStream(provider, rawSSE);

      if (!parsed.text && !parsed.reasoning && parsed.toolCalls.length === 0) {
        console.log("[ForeverChat] Buffer recovery: nothing extracted");
        return null;
      }

      const parts = await this._buildRecoveredParts(
        parsed.text,
        parsed.reasoning,
        parsed.toolCalls
      );

      console.log(
        `[ForeverChat] Buffer recovery (partial): ` +
          `${parsed.text.length} chars, ${parsed.toolCalls.length} tool calls — scheduling continuation`
      );

      this.messages.push({
        id: crypto.randomUUID(),
        role: "assistant" as const,
        parts: parts.messageParts as UIMessage["parts"]
      });
      await this.persistMessages([...this.messages]);

      this._lastBody = { ...this._lastBody, recovering: true };
      return { persist: false, continue: true };
    } catch (e) {
      console.error("[ForeverChat] Buffer recovery failed:", e);
      return null;
    }
  }

  private async _bufferStatus(
    bufferId: string
  ): Promise<{ status: string; chunkCount: number }> {
    const res = await this.env.INFERENCE_BUFFER.fetch(
      new Request(`https://buffer/status?id=${bufferId}`)
    );
    return (await res.json()) as { status: string; chunkCount: number };
  }

  private async _readBuffer(
    bufferId: string,
    isComplete: boolean
  ): Promise<string> {
    // /resume tails a live stream (blocks until done) — safe for completed
    // /drain snapshots what's stored — safe for still-streaming or interrupted
    const endpoint = isComplete ? "resume" : "drain";
    const res = await this.env.INFERENCE_BUFFER.fetch(
      new Request(`https://buffer/${endpoint}?id=${bufferId}&from=0`)
    );
    return res.text();
  }

  private async _ackBuffer(bufferId: string): Promise<void> {
    await this.env.INFERENCE_BUFFER.fetch(
      new Request(`https://buffer/ack?id=${bufferId}`, { method: "POST" })
    );
  }

  /**
   * Build UIMessage parts from recovered text, reasoning, and tool calls.
   * Executes server tools that don't need approval; provides synthetic
   * error results for client tools and approval-required tools.
   */
  private async _buildRecoveredParts(
    text: string,
    reasoning: string,
    toolCalls: ParsedToolCall[]
  ): Promise<{
    messageParts: Record<string, unknown>[];
    hasUnresolvedTools: boolean;
  }> {
    const messageParts: Record<string, unknown>[] = [];
    let hasUnresolvedTools = false;

    // Reasoning appears before text in the UI
    if (reasoning) {
      messageParts.push({ type: "reasoning", text: reasoning });
    }

    if (text) {
      messageParts.push({ type: "text", text });
    }

    for (const tc of toolCalls) {
      let args: unknown;
      try {
        args = JSON.parse(tc.arguments);
      } catch {
        continue;
      }

      const { output, resolved } = await this._executeRecoveredTool(
        tc.name,
        tc.id,
        args
      );
      if (!resolved) hasUnresolvedTools = true;

      messageParts.push({
        type: `tool-${tc.name}`,
        toolCallId: tc.id,
        toolName: tc.name,
        state: "output-available",
        input: args,
        output
      });
    }

    return { messageParts, hasUnresolvedTools };
  }

  /**
   * Try to execute a recovered tool call. Returns the output and whether
   * the tool was fully resolved.
   *
   * - Server tools without approval → execute, resolved
   * - Server tools with approval needed → synthetic error, unresolved
   * - Client tools (no execute) → synthetic error, unresolved
   */
  private async _executeRecoveredTool(
    name: string,
    toolCallId: string,
    args: unknown
  ): Promise<{ output: unknown; resolved: boolean }> {
    const toolDef = chatTools[name as keyof typeof chatTools];

    if (
      !toolDef ||
      !("execute" in toolDef) ||
      typeof toolDef.execute !== "function"
    ) {
      return {
        output: {
          error: "Tool could not be executed during recovery — please retry"
        },
        resolved: false
      };
    }

    // Check approval requirement
    if (
      "needsApproval" in toolDef &&
      typeof toolDef.needsApproval === "function"
    ) {
      try {
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- args parsed from SSE
        const needs = await (toolDef.needsApproval as (a: any) => any)(args);
        if (needs) {
          return {
            output: {
              error:
                "This action requires user approval which was interrupted — please try again"
            },
            resolved: false
          };
        }
      } catch {
        return {
          output: {
            error: "Could not verify approval requirement — please try again"
          },
          resolved: false
        };
      }
    }

    try {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- args parsed from raw SSE
      const output = await (toolDef.execute as (a: any, o: any) => any)(args, {
        toolCallId,
        messages: [],
        abortSignal: new AbortController().signal
      });
      return { output, resolved: true };
    } catch (e) {
      return {
        output: { error: `Tool failed during recovery: ${e}` },
        resolved: true
      };
    }
  }

  // ── Buffer integration ──────────────────────────────────────────
  //
  // The buffer is accessed via a service binding (INFERENCE_BUFFER).
  // Three methods handle routing:
  //
  // _routeThroughBuffer  — shared: generates buffer ID, stashes it, forwards
  // _makeBufferedFetch   — for OpenAI/Anthropic: wraps the AI SDK's fetch()
  // _makeBufferedAIBinding — for Workers AI: wraps the AI binding's run()
  //
  // The custom fetch / fake binding trick lets us intercept provider calls
  // without modifying the AI SDK or the provider libraries. The AI SDK
  // doesn't know it's going through a buffer — it sees a normal fetch
  // response (HTTP providers) or a normal ReadableStream (Workers AI).

  /**
   * Stash a new buffer ID and route a request through the buffer
   * service binding. Used by both _makeBufferedFetch (HTTP providers)
   * and _makeBufferedAIBinding (Workers AI).
   */
  private _routeThroughBuffer(proxyRequest: Request): Promise<Response> {
    const bufferId = crypto.randomUUID();
    this._bufferStash = { ...this._bufferStash, bufferId };
    this.stash({ ...this._bufferStash });

    const url = new URL(proxyRequest.url);
    url.searchParams.set("id", bufferId);

    return this.env.INFERENCE_BUFFER.fetch(
      new Request(url.toString(), proxyRequest)
    );
  }

  /**
   * Custom fetch for OpenAI/Anthropic: intercepts HTTP calls and routes
   * them through the buffer. Each call gets a unique buffer ID (important
   * for multi-step tool calls where streamText makes sequential fetches).
   */
  private _makeBufferedFetch(): typeof fetch {
    return async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      const headers = new Headers(init?.headers as HeadersInit);
      headers.set("X-Provider-URL", url);

      return this._routeThroughBuffer(
        new Request("https://buffer/proxy", {
          method: init?.method ?? "POST",
          headers,
          body: init?.body
        })
      );
    };
  }

  /**
   * Fake Ai binding for Workers AI: intercepts streaming run() calls
   * and routes them through the buffer. Non-streaming calls fall through
   * to the real binding.
   */
  private _makeBufferedAIBinding(): Ai {
    const realAI = this.env.AI;
    const agent = this;

    return {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- must match Ai.run overloads
      run: async (model: any, inputs: any, options?: any) => {
        if (!(inputs as Record<string, unknown>)?.stream) {
          return realAI.run(model, inputs, options);
        }

        const response = await agent._routeThroughBuffer(
          new Request("https://buffer/proxy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Provider-Type": "workers-ai",
              "X-AI-Model": String(model)
            },
            body: JSON.stringify(inputs)
          })
        );

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Buffer proxy failed (${response.status}): ${text}`);
        }

        return response.body;
      }
    } as unknown as Ai;
  }

  // ── Provider setup ──────────────────────────────────────────────
  //
  // When useBuffer is true, provider calls are intercepted:
  // - OpenAI/Anthropic: custom fetch routes HTTP calls through the buffer
  // - Workers AI: fake AI binding routes streaming run() through the buffer,
  //   non-streaming calls fall through to the real binding

  /**
   * Create a model for buffer replay — uses the real provider with a
   * replayFetch that returns the buffer response. The provider's own
   * SSE parser handles format conversion, so we never drift from the
   * maintained parsing code.
   */
  private _getReplayModel(
    provider: Provider,
    replayFetch: typeof fetch
  ): LanguageModelV3 {
    switch (provider) {
      case "openai":
        return createOpenAI({
          apiKey: "buffer-replay",
          fetch: replayFetch
        })("gpt-5.4");
      case "anthropic":
        return createAnthropic({
          apiKey: "buffer-replay",
          fetch: replayFetch
        })("claude-sonnet-4-6");
      default:
        return createWorkersAI({
          accountId: "buffer-replay",
          apiKey: "buffer-replay",
          fetch: replayFetch
        })("@cf/moonshotai/kimi-k2.6", {
          sessionAffinity: this.sessionAffinity
        });
    }
  }

  private _getModel(provider: Provider, useBuffer: boolean) {
    switch (provider) {
      case "openai":
        return createOpenAI({
          apiKey: this.env.OPENAI_API_KEY,
          ...(useBuffer && { fetch: this._makeBufferedFetch() })
        })("gpt-5.4");
      case "anthropic":
        return createAnthropic({
          apiKey: this.env.ANTHROPIC_API_KEY,
          ...(useBuffer && { fetch: this._makeBufferedFetch() })
        })("claude-sonnet-4-6");
      default: {
        const binding = useBuffer ? this._makeBufferedAIBinding() : this.env.AI;
        return createWorkersAI({ binding })("@cf/moonshotai/kimi-k2.6", {
          sessionAffinity: this.sessionAffinity
        });
      }
    }
  }

  private _getProviderOptions(
    provider: Provider,
    recovering: boolean
  ): Record<string, Record<string, unknown>> | undefined {
    if (provider === "openai") {
      return {
        openai: {
          store: true,
          reasoningEffort: "low",
          reasoningSummary: "auto"
        }
      };
    }
    if (provider === "anthropic") {
      return {
        anthropic: recovering
          ? { thinking: { type: "disabled" } }
          : { thinking: { type: "adaptive" } }
      };
    }
    return undefined;
  }

  private _getChunkHandlers(
    provider: Provider,
    useBuffer: boolean
  ): {
    includeRawChunks?: boolean;
    onChunk?: (event: { chunk: { type: string; rawValue?: unknown } }) => void;
  } {
    if (provider !== "openai") return {};

    return {
      includeRawChunks: true,
      onChunk: ({ chunk }) => {
        if (chunk.type !== "raw") return;
        const raw = chunk.rawValue as
          | { type?: string; response?: { id?: string } }
          | undefined;
        if (raw?.type === "response.created" && raw.response?.id) {
          if (useBuffer) {
            this._bufferStash = {
              ...this._bufferStash,
              responseId: raw.response.id
            };
            this.stash({ ...this._bufferStash });
          } else {
            this.stash({ responseId: raw.response.id });
          }
        }
      }
    };
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
