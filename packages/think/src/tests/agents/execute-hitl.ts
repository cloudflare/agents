/**
 * Test agent for the Think HITL bridge (Stage 4): an approval-gated AI SDK
 * tool inside the execute tool's sandbox pauses the run durably; the
 * built-in `approveExecution` / `rejectExecution` callables resume it and
 * replace the paused tool output in the transcript.
 *
 * The mock model:
 *  - with no execute result in the prompt, calls the `execute` tool with the
 *    code the test configured (`setExecuteCode`);
 *  - otherwise emits text reporting every execution status it can see in the
 *    prompt (`seen:<status,...>`), so tests can assert what the model
 *    observed on each (auto-)continuation.
 */
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import { createExecuteTool } from "../../tools/execute";

function promptHasExecuteResult(options: Record<string, unknown>): boolean {
  const messages = (options as { prompt?: unknown[] }).prompt ?? [];
  return messages.some(
    (m: unknown) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).role === "tool"
  );
}

function statusesInPrompt(options: Record<string, unknown>): string[] {
  const serialized = JSON.stringify(
    (options as { prompt?: unknown[] }).prompt ?? []
  );
  const seen: string[] = [];
  const re = /"status"\s*:\s*"(completed|paused|rejected|error)"/g;
  for (const match of serialized.matchAll(re)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

function enqueueExecuteCall(
  controller: ReadableStreamDefaultController,
  id: string,
  code: string
) {
  const json = JSON.stringify({ code });
  controller.enqueue({
    type: "tool-input-start",
    id,
    toolName: "execute"
  });
  controller.enqueue({ type: "tool-input-delta", id, delta: json });
  controller.enqueue({ type: "tool-input-end", id });
  controller.enqueue({
    type: "tool-call",
    toolCallId: id,
    toolName: "execute",
    input: json
  });
}

function createHitlMockModel(agent: ThinkExecuteHitlAgent): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-execute-hitl",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream(options: Record<string, unknown>) {
      callCount++;
      const step = callCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (step === 1 && !promptHasExecuteResult(options)) {
            const codes = agent.executeCodes();
            codes.forEach((code, i) => {
              enqueueExecuteCall(controller, `tc-exec-${step}-${i}`, code);
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            const id = `t-${step}`;
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({
              type: "text-delta",
              id,
              delta: `seen:${statusesInPrompt(options).join(",")}`
            });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Flat, RPC-serializable snapshot of an execute tool output (an `unknown`
// or recursive type would collapse the stub method's type to `never`).
// `result` and `args` are JSON-stringified when structured.
export type ExecuteOutputSnapshot = {
  status?: string;
  executionId?: string;
  result?: string | number | boolean | null;
  error?: string;
  reason?: string;
  pending?: Array<{ connector?: string; method?: string; args?: string }>;
};

type ExecutePartSnapshot = {
  toolCallId: string;
  state: string;
  output?: ExecuteOutputSnapshot;
};

function snapshotOutput(raw: unknown): ExecuteOutputSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  return {
    status: o.status as string | undefined,
    executionId: o.executionId as string | undefined,
    result:
      o.result == null || typeof o.result === "object"
        ? o.result == null
          ? undefined
          : JSON.stringify(o.result)
        : (o.result as string | number | boolean),
    error: o.error as string | undefined,
    reason: o.reason as string | undefined,
    pending: Array.isArray(o.pending)
      ? (o.pending as Array<Record<string, unknown>>).map((p) => ({
          connector: p.connector as string | undefined,
          method: p.method as string | undefined,
          args: p.args === undefined ? undefined : JSON.stringify(p.args)
        }))
      : undefined
  };
}

export class ThinkExecuteHitlAgent extends Think {
  #codes: string[] = [`async () => await tools.deploy({ target: "prod" })`];
  #gatedCalls = 0;

  executeCodes(): string[] {
    return this.#codes;
  }

  async setExecuteCodes(codes: string[]): Promise<void> {
    this.#codes = codes;
  }

  override getModel(): LanguageModel {
    return createHitlMockModel(this);
  }

  override getTools(): ToolSet {
    // Agent one-liner + custom tools: state.* from the workspace, executor
    // from env.LOADER, tools.* with an approval-gated tool. needsApproval
    // maps to requiresApproval — calling it pauses the run durably.
    return {
      execute: createExecuteTool(this, {
        tools: {
          deploy: tool({
            description: "Deploy to a target (requires human approval)",
            inputSchema: z.object({ target: z.string() }),
            needsApproval: true,
            execute: async ({ target }) => {
              this.#gatedCalls++;
              return `deployed:${target}`;
            }
          })
        }
      })
    };
  }

  /** How many times the gated tool actually executed. */
  async gatedCallCount(): Promise<number> {
    return this.#gatedCalls;
  }

  /** All execute tool parts in the transcript, oldest first. */
  async executeParts(): Promise<ExecutePartSnapshot[]> {
    const out: ExecutePartSnapshot[] = [];
    for (const message of this.messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts as Array<Record<string, unknown>>) {
        if (part.type === "tool-execute") {
          out.push({
            toolCallId: part.toolCallId as string,
            state: part.state as string,
            output: snapshotOutput(part.output)
          });
        }
      }
    }
    return out;
  }

  /** Text content of the last assistant message — the model's narration. */
  async lastAssistantText(): Promise<string> {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i] as UIMessage;
      if (message.role !== "assistant") continue;
      const text = message.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      if (text) return text;
    }
    return "";
  }

  /**
   * Simulate compaction summarizing the execute tool part away: strip every
   * `tool-execute` part from the transcript.
   */
  async stripExecutePartsForTest(): Promise<void> {
    for (const message of this.messages) {
      if (message.role !== "assistant") continue;
      const parts = message.parts as Array<Record<string, unknown>>;
      if (!parts.some((p) => p.type === "tool-execute")) continue;
      const remaining = parts.filter((p) => p.type !== "tool-execute");
      await this.updateMessageInHistory({
        ...message,
        parts: (remaining.length > 0
          ? remaining
          : [{ type: "text", text: "(summarized)" }]) as UIMessage["parts"]
      } as UIMessage);
    }
  }

  /** Text of system messages (the orphaned-outcome fallback notes). */
  async systemNoteTexts(): Promise<string[]> {
    return this.messages
      .filter((m) => m.role === "system")
      .map((m) =>
        (m as UIMessage).parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("")
      );
  }

  /** Expire all paused runs immediately (stage 1 `expirePaused`). */
  async expirePausedForTest(): Promise<string[]> {
    if (!this.codemode) throw new Error("no codemode runtime");
    return this.codemode.expirePaused({ maxAgeMs: 0 });
  }

  /**
   * Simulate a DO restart for the approval path: drop the in-memory handle
   * so `approveExecution` must re-derive it via `getTools()`.
   */
  async dropCodemodeHandleForTest(): Promise<void> {
    this.codemode = undefined;
  }
}
