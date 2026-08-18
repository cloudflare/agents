/**
 * Deterministic dev model driver.
 *
 * Used when no Workers AI credentials are available (tests, offline dev).
 * It is not a canned transcript: replies are derived from the live system
 * prompt and conversation, so it genuinely exercises the harness hot-reload
 * path — when the agent rewrites its own identity.md, the persona line in
 * every subsequent reply changes because the new prompt actually flowed
 * through the kernel's turn loop.
 *
 * Protocol (driven by the user message):
 *   !tool <name> <json>       call tool <name> with <json> input
 *   !tools [{"name","input"}]  call several tools in sequence, one per step,
 *                              within the same turn (like a real multi-step
 *                              model turn — no harness reload in between)
 *   anything else              echo reply, prefixed with the live PERSONA line
 */

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage
} from "@ai-sdk/provider";

const USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: 0,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 0, text: 0, reasoning: undefined }
};

function systemText(prompt: LanguageModelV4Prompt): string {
  return prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content as string)
    .join("\n");
}

function personaLine(prompt: LanguageModelV4Prompt): string {
  const match = systemText(prompt).match(/^PERSONA:\s*(.+)$/m);
  return match ? match[1].trim() : "(no persona found)";
}

function lastUserText(prompt: LanguageModelV4Prompt): {
  text: string;
  index: number;
} {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== "user") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("");
    return { text, index: i };
  }
  return { text: "", index: -1 };
}

interface PendingToolResult {
  toolName: string;
  output: unknown;
}

function toolResultsAfter(
  prompt: LanguageModelV4Prompt,
  index: number
): PendingToolResult[] {
  const results: PendingToolResult[] = [];
  for (let i = index + 1; i < prompt.length; i++) {
    const message = prompt[i];
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const p = part as { toolName: string; output?: unknown };
      results.push({ toolName: p.toolName, output: p.output });
    }
  }
  return results;
}

/** What the "model" decided to do this round. */
type TurnPlan =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: string };

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: undefined };
const TOOL_CALLS: LanguageModelV4FinishReason = {
  unified: "tool-calls",
  raw: undefined
};

function describeOutput(output: unknown): string {
  // Tool result outputs arrive as { type: "json" | "text" | ..., value }.
  const value =
    output && typeof output === "object" && "value" in output
      ? (output as { value: unknown }).value
      : output;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return json && json.length > 400 ? `${json.slice(0, 400)}…` : (json ?? "");
}

let callCounter = 0;

function planTurn(options: LanguageModelV4CallOptions): TurnPlan {
  const prompt = options.prompt;
  const persona = personaLine(prompt);
  const { text: userText, index } = lastUserText(prompt);
  const results = toolResultsAfter(prompt, index);

  // Multi-step sequence: issue the next queued call until all are done.
  const multiMatch = userText.match(/^!tools\s+(\[[\s\S]*\])\s*$/);
  if (multiMatch) {
    let calls: { name: string; input?: unknown }[];
    try {
      calls = JSON.parse(multiMatch[1]) as { name: string; input?: unknown }[];
    } catch {
      return { kind: "text", text: `[${persona}] Could not parse !tools JSON.` };
    }
    if (results.length < calls.length) {
      const next = calls[results.length];
      callCounter += 1;
      return {
        kind: "tool-call",
        toolCallId: `mock-call-${callCounter}`,
        toolName: next.name,
        input: JSON.stringify(next.input ?? {})
      };
    }
    const summary = results
      .map((r) => `\`${r.toolName}\` → ${describeOutput(r.output)}`)
      .join("; ");
    return { kind: "text", text: `[${persona}] Ran ${results.length} tools: ${summary}` };
  }

  // A tool already ran this turn — report its result and stop.
  if (results.length > 0) {
    const last = results[results.length - 1];
    return {
      kind: "text",
      text: `[${persona}] Tool \`${last.toolName}\` returned: ${describeOutput(last.output)}`
    };
  }

  const toolMatch = userText.match(/^!tool\s+([\w-]+)\s*(\{[\s\S]*\})?\s*$/);
  if (toolMatch) {
    const [, toolName, jsonArg] = toolMatch;
    callCounter += 1;
    return {
      kind: "tool-call",
      toolCallId: `mock-call-${callCounter}`,
      toolName,
      input: jsonArg ?? "{}"
    };
  }

  return { kind: "text", text: `[${persona}] You said: "${userText}"` };
}

function planToChunks(plan: TurnPlan): LanguageModelV4StreamPart[] {
  if (plan.kind === "tool-call") {
    return [
      {
        type: "tool-call",
        toolCallId: plan.toolCallId,
        toolName: plan.toolName,
        input: plan.input
      },
      { type: "finish", finishReason: TOOL_CALLS, usage: USAGE }
    ];
  }
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: plan.text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: STOP, usage: USAGE }
  ];
}

function planToContent(plan: TurnPlan): {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
} {
  if (plan.kind === "tool-call") {
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: plan.toolCallId,
          toolName: plan.toolName,
          input: plan.input
        }
      ],
      finishReason: TOOL_CALLS
    };
  }
  return {
    content: [{ type: "text", text: plan.text }],
    finishReason: STOP
  };
}

/**
 * Create the scripted dev model. Deterministic, offline, and driven entirely
 * by the live prompt — see module docs for the message protocol.
 */
export function createMockModel() {
  return new MockLanguageModelV4({
    modelId: "exo-mock",
    doGenerate: async (options) => {
      const { content, finishReason } = planToContent(planTurn(options));
      return { content, finishReason, usage: USAGE, warnings: [] };
    },
    doStream: async (options) => ({
      stream: simulateReadableStream({
        chunks: planToChunks(planTurn(options))
      })
    })
  });
}
