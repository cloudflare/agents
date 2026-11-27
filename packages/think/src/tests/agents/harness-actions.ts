/**
 * The harness-backed Think (always, under either test config) with two
 * actions that need a human: an approval-gated one and a durable-pause one.
 * The model calls the action named in the prompt once, then answers with
 * the tool result it got.
 */
import type { LanguageModel } from "ai";
import { z } from "zod";
import { action, type Action } from "../../actions";
import { Think } from "../../harness/think";
import type {
  ActionAuthorizationDecision,
  StreamCallback,
  ToolCallContext,
  ToolCallDecision,
  TurnContext
} from "../../think";

const COUNT_KEY = "test:charged";
const GRANT_KEY = "test:grant";
const REWRITE_KEY = "test:rewrite";

function finish(controller: ReadableStreamDefaultController, reason: string) {
  controller.enqueue({
    type: "finish",
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 }
    }
  });
  controller.close();
}

/** Calls the action the prompt names; after a tool result, says what it got. */
function actionModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-harness-actions",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: { prompt: { role: string; content: unknown }[] }) {
      const last = options.prompt[options.prompt.length - 1];
      const prompt = JSON.stringify(options.prompt);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (last.role === "tool") {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({
              type: "text-delta",
              id: "t",
              delta: `got ${JSON.stringify(last.content)}`
            });
            controller.enqueue({ type: "text-end", id: "t" });
            finish(controller, "stop");
            return;
          }
          const toolName = prompt.includes("pause") ? "pauseCharge" : "charge";
          controller.enqueue({
            type: "tool-call",
            toolCallId: "call-1",
            toolName,
            input: JSON.stringify({ amount: 5 })
          });
          finish(controller, "tool-calls");
        }
      });
      return Promise.resolve({ stream });
    }
  } as unknown as LanguageModel;
}

const quiet: StreamCallback = {
  onStart() {},
  onEvent() {},
  onDone() {},
  onError() {}
};

export class ThinkHarnessActionsAgent extends Think {
  override getModel(): LanguageModel {
    return actionModel();
  }

  override getActions(): Record<string, Action> {
    const run = async ({ amount }: { amount: number }) => {
      const count = (this.ctx.storage.kv.get<number>(COUNT_KEY) ?? 0) + 1;
      this.ctx.storage.kv.put(COUNT_KEY, count);
      return { charged: amount };
    };
    return {
      charge: action({
        description: "Charge the card",
        approvalSummary: "Charge the customer's card",
        approvalRisk: "high",
        permissions: ["billing:charge"],
        inputSchema: z.object({ amount: z.number() }),
        approval: true,
        execute: run
      }),
      pauseCharge: action({
        description: "Charge the card after a human approves",
        kind: "durable-pause",
        // Computed from the input.
        permissions: ({ input }) => [`billing:charge:${input.amount}`],
        inputSchema: z.object({ amount: z.number() }),
        execute: run
      })
    };
  }

  override authorizeTurn(_ctx: TurnContext): ActionAuthorizationDecision {
    const grant = this.ctx.storage.kv.get<string[]>(GRANT_KEY);
    return grant === undefined
      ? true
      : { allowed: true, grantedPermissions: grant };
  }

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const amount = this.ctx.storage.kv.get<number>(REWRITE_KEY);
    if (amount === undefined || ctx.toolName !== "charge") return;
    return { action: "allow", input: { amount } };
  }

  /** Rewrite each `charge` call's input to this amount. */
  rewriteForTest(amount: number): void {
    this.ctx.storage.kv.put(REWRITE_KEY, amount);
  }

  /** The permissions the next turn is granted; `undefined` grants all. */
  grantForTest(permissions: string[] | undefined): void {
    if (permissions === undefined) this.ctx.storage.kv.delete(GRANT_KEY);
    else this.ctx.storage.kv.put(GRANT_KEY, permissions);
  }

  async toolOutputs(): Promise<unknown[]> {
    return this.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        "toolCallId" in part && "output" in part ? [part.output] : []
      )
    );
  }

  async say(text: string): Promise<void> {
    await this.chat(text, quiet);
  }

  /** Ends this object, so the next call meets a fresh isolate. */
  resetForTest(): void {
    this.ctx.abort("test: reset");
  }

  charged(): number {
    return this.ctx.storage.kv.get<number>(COUNT_KEY) ?? 0;
  }

  async toolStates(): Promise<string[]> {
    return this.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        "toolCallId" in part ? [String(part.state)] : []
      )
    );
  }

  async lastText(): Promise<string> {
    const last = this.messages[this.messages.length - 1];
    return last.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("");
  }
}
