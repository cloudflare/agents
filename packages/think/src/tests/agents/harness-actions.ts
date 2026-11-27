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
const SWEEP_KEY = "test:sweep-settled";
const GRANT_CONTEXT_KEY = "test:grant-context";
const MODEL_FAILS_KEY = "test:model-fails";
const MODEL_HOLD_KEY = "test:model-hold";

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
/** Model calls to fail with a lost connection, and the calls made. */
let lostConnections = 0;
let modelCalls = 0;

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
      modelCalls++;
      if (lostConnections > 0) {
        lostConnections--;
        return Promise.reject(new Error("Network connection lost."));
      }
      const last = options.prompt[options.prompt.length - 1];
      const prompt = JSON.stringify(options.prompt);
      // The reply after the tool result fails when the question asks so.
      if (last.role === "tool" && prompt.includes("then fail")) {
        return Promise.reject(new Error("the follow-up reply failed"));
      }
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
          const toolName = prompt.includes("receipt")
            ? "receipt"
            : prompt.includes("pause")
              ? "pauseCharge"
              : "charge";
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
  override getModel(): LanguageModel | Promise<LanguageModel> {
    if (this.ctx.storage.kv.get<boolean>(MODEL_FAILS_KEY)) {
      throw new Error("no model today");
    }
    if (this.ctx.storage.kv.get<boolean>(MODEL_HOLD_KEY)) {
      this.ctx.storage.kv.put(MODEL_HOLD_KEY, false);
      this.#modelEntered = true;
      return new Promise((resolve) => {
        this.#releaseModel = () => resolve(actionModel());
      });
    }
    return actionModel();
  }

  #modelEntered = false;
  #releaseModel: (() => void) | undefined;

  /** The next `getModel()` waits until released. */
  holdModelForTest(): void {
    this.ctx.storage.kv.put(MODEL_HOLD_KEY, true);
  }

  modelEnteredForTest(): boolean {
    return this.#modelEntered;
  }

  releaseModelForTest(): void {
    this.#releaseModel?.();
  }

  /** Whether no operation is in flight (the last one has settled). */
  async idleForTest(): Promise<boolean> {
    return (await this.harness.session().inFlight()) === undefined;
  }

  /** From now on, `getModel()` throws. */
  failModelForTest(): void {
    this.ctx.storage.kv.put(MODEL_FAILS_KEY, true);
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
      receipt: action({
        description: "Send a receipt",
        inputSchema: z.object({ amount: z.number() }),
        execute: ({ amount }, ctx) => {
          ctx.attachReply({ type: "receipt", amount });
          // @ts-expect-error: a value that is not an attachment is ignored
          ctx.attachReply("not an attachment");
          return { sent: true };
        }
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

  override authorizeTurn(ctx: TurnContext): ActionAuthorizationDecision {
    this.ctx.storage.kv.put(GRANT_CONTEXT_KEY, {
      trigger: ctx.trigger ?? null,
      hasSignal: ctx.abortSignal instanceof AbortSignal,
      ...(ctx.abortSignal?.aborted && { aborted: true })
    });
    const grant = this.ctx.storage.kv.get<string[]>(GRANT_KEY);
    return grant === undefined
      ? true
      : { allowed: true, grantedPermissions: grant };
  }

  override async onStart(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>(SWEEP_KEY)) {
      this.actionLedgerRetention = {
        ...this.actionLedgerRetention,
        settledMs: 0
      };
    }
  }

  /** Keep settled ledger rows for no time from the next start. */
  sweepSettledForTest(): void {
    this.ctx.storage.kv.put(SWEEP_KEY, true);
  }

  /** The action ledger's rows. */
  ledgerRowsForTest(): number {
    return this.tasks.peekList({ definition: "__cf_think_action_effect" })
      .length;
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

  /** What `authorizeTurn` was last told about its turn. */
  grantContext():
    | { trigger: string | null; hasSignal: boolean; aborted?: true }
    | undefined {
    return this.ctx.storage.kv.get(GRANT_CONTEXT_KEY);
  }

  async say(text: string): Promise<void> {
    await this.chat(text, quiet);
  }

  /** The next `count` model calls lose their connection. */
  loseConnectionsForTest(count: number): void {
    lostConnections = count;
  }

  modelCallsForTest(): number {
    return modelCalls;
  }

  /** From now on, the app's classifyChatError names every error `as`. */
  classifyErrorsAsForTest(as: "fatal" | "transient" | "rate_limit"): void {
    this.classifyChatError = () => as;
  }

  /** Ends this object, so the next call meets a fresh isolate. */
  resetForTest(): void {
    this.ctx.abort("test: reset");
  }

  attachmentsForTest(requestId?: string): unknown[] {
    return this.replyAttachments(requestId);
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
