/**
 * DEMO MODULE — LanguageModel, the practical one.
 *
 * The Vercel AI SDK as ONE ADAPTER AMONG PEERS: every provider the `ai`
 * ecosystem supports (OpenAI, Anthropic, Google, Workers AI via provider,
 * gateways, middleware-wrapped models) arrives behind our seam through this
 * one function. The SDK is not the foundation of the agent — it is a model
 * vendor. Iteration, tools, durability all stay ours: streamText is called
 * with schema-only tools (no execute), so the SDK never runs its own loop.
 *
 * NOT RUNNABLE IN THIS REPO'S LOCAL DEMO: it needs the `ai` package at
 * runtime (typechecked against vendor/node_modules/ai; a deployed worker
 * resolves `ai` normally via its bundler). Deliberately no fallback — wire a
 * real provider model in and it works, don't and it throws.
 */

import { jsonSchema, streamText, tool } from "ai";
import type {
  LanguageModel as AiSdkModel,
  ModelMessage,
  ToolSet
} from "ai";
import type {
  Json,
  LanguageModel,
  LanguageModelErrorKind,
  LanguageModelRequest,
  Part
} from "../../contract";

export function aiSdkModel(model: AiSdkModel): LanguageModel {
  return {
    async generate(req, io) {
      const result = streamText({
        model,
        ...(req.system !== undefined ? { instructions: req.system } : {}),
        messages: toModelMessages(req),
        ...(req.tools !== undefined && req.tools.length > 0
          ? { tools: toToolSet(req) }
          : {}),
        ...(io.signal !== undefined ? { abortSignal: io.signal } : {})
      });

      let text = "";
      let reasoning = "";
      const calls: Part[] = [];
      let finish: "stop" | "tool-calls" | "length" | "content-filter" | "error" = "stop";
      let usage: { inputTokens?: number; outputTokens?: number } = {};

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            text += part.text;
            io.onChunk?.({ type: "text-delta", delta: part.text });
            break;
          case "reasoning-delta":
            reasoning += part.text;
            io.onChunk?.({ type: "reasoning-delta", delta: part.text });
            break;
          case "tool-call": {
            const call: Part = {
              type: "tool-call",
              callId: part.toolCallId,
              name: fromProviderToolName(part.toolName),
              input: part.input as Json
            };
            calls.push(call);
            io.onChunk?.({ ...call, type: "tool-call" } as never);
            break;
          }
          case "finish":
            finish =
              part.finishReason === "tool-calls" ? "tool-calls"
              : part.finishReason === "length" ? "length"
              : part.finishReason === "content-filter" ? "content-filter"
              : part.finishReason === "stop" ? "stop"
              : "error";
            usage = {
              ...(part.totalUsage.inputTokens !== undefined
                ? { inputTokens: part.totalUsage.inputTokens }
                : {}),
              ...(part.totalUsage.outputTokens !== undefined
                ? { outputTokens: part.totalUsage.outputTokens }
                : {})
            };
            break;
          case "error":
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }

      const parts: Part[] = [
        ...(reasoning.length > 0 ? [{ type: "reasoning", text: reasoning } as Part] : []),
        ...(text.length > 0 ? [{ type: "text", text } as Part] : []),
        ...calls
      ];
      return { parts, finish, usage };
    },

    classifyError(error: unknown): LanguageModelErrorKind {
      const status = (error as { statusCode?: number })?.statusCode;
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (message.includes("context length") || message.includes("maximum context") || message.includes("too many tokens")) {
        return "context-overflow";
      }
      if (status === 429 || message.includes("rate limit")) return "rate-limit";
      if (
        (status !== undefined && status >= 500) ||
        message.includes("timeout") ||
        message.includes("fetch failed") ||
        message.includes("network")
      ) {
        return "transient";
      }
      return "fatal";
    }
  };
}

// -- translation ------------------------------------------------------------

/** Providers reject "/" in tool names; carry our namespacing as "__". */
const toProviderToolName = (name: string) => name.replace(/\//g, "__");
const fromProviderToolName = (name: string) => name.replace(/__/g, "/");

function toToolSet(req: LanguageModelRequest): ToolSet {
  const entries = (req.tools ?? []).map((t) => [
    toProviderToolName(t.name),
    // No execute function: the SDK surfaces the call and stops; execution
    // belongs to our ToolRuntime (claim/settle) on the other side of the seam.
    tool({
      description: t.description,
      inputSchema: jsonSchema(t.input as Parameters<typeof jsonSchema>[0])
    })
  ]);
  return Object.fromEntries(entries) as ToolSet;
}

function toModelMessages(req: LanguageModelRequest): ModelMessage[] {
  // Tool-result parts need their toolName back; recover it from the
  // preceding tool-call with the same callId.
  const callNames = new Map<string, string>();
  for (const m of req.messages) {
    for (const p of m.parts) {
      if (p.type === "tool-call") callNames.set(p.callId, p.name);
    }
  }

  const out: ModelMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m.parts) });
    } else if (m.role === "user") {
      out.push({ role: "user", content: textOf(m.parts) });
    } else if (m.role === "assistant") {
      type AssistantPart =
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };
      out.push({
        role: "assistant",
        content: m.parts.flatMap((p): AssistantPart[] => {
          if (p.type === "text") return [{ type: "text", text: p.text }];
          if (p.type === "tool-call") {
            return [
              {
                type: "tool-call",
                toolCallId: p.callId,
                toolName: toProviderToolName(p.name),
                input: p.input
              }
            ];
          }
          return [];
        })
      });
    } else {
      // role "tool": the ADR 0004 carrier role, translated 1:1.
      out.push({
        role: "tool",
        content: m.parts.flatMap((p) => {
          if (p.type !== "tool-result") return [];
          return [
            {
              type: "tool-result" as const,
              toolCallId: p.callId,
              toolName: toProviderToolName(callNames.get(p.callId) ?? "unknown"),
              output:
                typeof p.output === "string"
                  ? { type: "text" as const, value: p.output }
                  : { type: "json" as const, value: p.output as never }
            }
          ];
        })
      });
    }
  }
  return out;
}

function textOf(parts: readonly Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}
