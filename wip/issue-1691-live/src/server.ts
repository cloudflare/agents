/**
 * Live #1691 repro worker.
 *
 * A real-LLM `AIChatAgent` (chatRecovery on) that streams its response through
 * `streamText(...).toUIMessageStreamResponse()` — the standard pattern, which
 * does NOT inject a `start.messageId`. That is exactly the condition that
 * triggers #1691: when a stream is interrupted before its assistant message is
 * persisted, recovery has no provider id to key on and (before the fix) fell
 * back to the LAST assistant message, merging a new turn into the previous one.
 *
 * The provider is chosen at runtime by the `LLM_PROVIDER` var so the same agent
 * can be exercised against Workers AI, OpenAI, and Anthropic.
 */
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { Think } from "@cloudflare/think";
import { streamText, convertToModelMessages, type LanguageModel } from "ai";
import type { UIMessage } from "ai";

type Env = {
  LiveChatAgent: DurableObjectNamespace<LiveChatAgent>;
  LiveThinkAgent: DurableObjectNamespace<LiveThinkAgent>;
  AI: Ai;
  LLM_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

/** Shared provider switch backing both the ai-chat and think agents. */
function resolveModel(env: Env): LanguageModel {
  const provider = (env.LLM_PROVIDER ?? "workers-ai").toLowerCase();
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-4o-mini");
    case "anthropic":
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(
        "claude-haiku-4-5"
      );
    default:
      return createWorkersAI({ binding: env.AI })(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      );
  }
}

const RECOVERY_COUNT_KEY = "test:recovery-count";

type MessageSummary = {
  provider: string;
  recoveryCount: number;
  assistantCount: number;
  userCount: number;
  messages: Array<{ id: string; role: string; text: string }>;
};

function textOf(message: UIMessage): string {
  return message.parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof (p as { text?: unknown }).text === "string"
    )
    .map((p) => p.text)
    .join("");
}

export class LiveChatAgent extends AIChatAgent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;

  private _resolveModel(): { provider: string; model: LanguageModel } {
    const provider = (this.env.LLM_PROVIDER ?? "workers-ai").toLowerCase();
    switch (provider) {
      case "openai": {
        const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
        return { provider, model: openai("gpt-4o-mini") };
      }
      case "anthropic": {
        const anthropic = createAnthropic({
          apiKey: this.env.ANTHROPIC_API_KEY
        });
        return { provider, model: anthropic("claude-haiku-4-5") };
      }
      case "workers-ai":
      default: {
        const workersai = createWorkersAI({ binding: this.env.AI });
        return {
          provider: "workers-ai",
          model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast")
        };
      }
    }
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ) {
    const { model } = this._resolveModel();
    const result = streamText({
      abortSignal: options?.abortSignal,
      model,
      system:
        "You are a terse assistant. Follow the user's formatting instructions exactly.",
      messages: await convertToModelMessages(this.messages)
    });
    // No generateMessageId / messageId — the UI stream's `start` part carries
    // no messageId, which is the #1691 condition.
    return result.toUIMessageStreamResponse();
  }

  override onError(error: unknown): never {
    console.error(
      `[live-1691] onError (${this.env.LLM_PROVIDER}):`,
      error instanceof Error ? error.stack || error.message : String(error)
    );
    throw error instanceof Error ? error : new Error(String(error));
  }

  override async onChatRecovery() {
    const count = (await this.ctx.storage.get<number>(RECOVERY_COUNT_KEY)) ?? 0;
    await this.ctx.storage.put(RECOVERY_COUNT_KEY, count + 1);
    return {};
  }

  @callable()
  async summary(): Promise<MessageSummary> {
    const recoveryCount =
      (await this.ctx.storage.get<number>(RECOVERY_COUNT_KEY)) ?? 0;
    return {
      provider: (this.env.LLM_PROVIDER ?? "workers-ai").toLowerCase(),
      recoveryCount,
      assistantCount: this.messages.filter((m) => m.role === "assistant")
        .length,
      userCount: this.messages.filter((m) => m.role === "user").length,
      messages: this.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: textOf(m)
      }))
    };
  }
}

/**
 * The same #1691 scenario against `@cloudflare/think`. Think uses a session
 * message-tree and allocates a distinct message id per recovered turn, so it is
 * expected to be UNAFFECTED — this agent exists to confirm that empirically with
 * the identical kill/restart sequence the ai-chat agent runs through.
 */
export class LiveThinkAgent extends Think<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;
  override maxSteps = 4;

  override getModel(): LanguageModel {
    return resolveModel(this.env);
  }

  override getSystemPrompt(): string {
    return "You are a terse assistant. Follow the user's formatting instructions exactly.";
  }

  override onError(error: unknown): void {
    console.error(
      `[live-1691 think] onError (${this.env.LLM_PROVIDER}):`,
      error instanceof Error ? error.stack || error.message : String(error)
    );
  }

  override async onChatRecovery() {
    const count = (await this.ctx.storage.get<number>(RECOVERY_COUNT_KEY)) ?? 0;
    await this.ctx.storage.put(RECOVERY_COUNT_KEY, count + 1);
    return {};
  }

  @callable()
  async summary(): Promise<MessageSummary> {
    const recoveryCount =
      (await this.ctx.storage.get<number>(RECOVERY_COUNT_KEY)) ?? 0;
    return {
      provider: (this.env.LLM_PROVIDER ?? "workers-ai").toLowerCase(),
      recoveryCount,
      assistantCount: this.messages.filter((m) => m.role === "assistant")
        .length,
      userCount: this.messages.filter((m) => m.role === "user").length,
      messages: this.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: textOf(m)
      }))
    };
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
