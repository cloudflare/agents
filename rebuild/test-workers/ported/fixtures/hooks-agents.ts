// @ts-nocheck
import { z } from "zod";

import {
  Think,
  action,
  hostAgent,
  tool,
  type Action,
  type AgentHost,
  type ChatMessage,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type StreamCallback,
  type ToolSet
} from "../compat.js";

type JsonRecord = Record<string, unknown>;
type EchoMode =
  | "default"
  | "permission"
  | "throw"
  | "timeout"
  | "large-output"
  | "non-json-output"
  | "ledger-key"
  | "ledger-throw"
  | "ledger-slow"
  | "ledger-symbol-output"
  | "approval"
  | "approval-permission"
  | "ledger-approval"
  | "function-policy";

type ExecuteMode =
  | "default"
  | "async-generator"
  | "async-iterable"
  | "sync-iterable"
  | "add-messages"
  | "needs-approval";

type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
  requestId?: string;
};

const HOOKS_HOST_BRIDGE_GAP =
  "missing-feature no-issue-yet: Think exposes no host-bridge surface (_hostWriteFile/_hostReadFile/etc. have no equivalent; workspace is private not protected; no _insideInferenceLoop tracking)";

const HOOKS_EXTENSION_GAP =
  "missing-feature ISSUE-006: extension hook dispatch requires the extension/plugin seam";

const rpcMethodNames = [
  "addDynamicContext",
  "executeEchoActionToolForTest",
  "executeEchoActionToolParallelForTest",
  "getActionProbe",
  "getAfterToolCallLog",
  "getBeforeStepLog",
  "getBeforeToolCallLog",
  "getBeforeTurnLog",
  "getCachedMessagesForTest",
  "getCapturedOptions",
  "getChunkCount",
  "getContextBlockContent",
  "getContextBlockDetails",
  "getContextLabels",
  "getEchoExecuteCount",
  "getLastModelCallSettings",
  "getMessages",
  "getMidTurnAddProbe",
  "getSessionToolNames",
  "getStepLog",
  "getStoredMessages",
  "getSystemPromptSnapshot",
  "getToolResultChunkLog",
  "hostDeleteFile",
  "hostGetContext",
  "hostGetMessages",
  "hostGetSessionInfo",
  "hostListFiles",
  "hostReadFile",
  "hostSendMessage",
  "hostSetContext",
  "hostWriteFile",
  "insertActionLedgerRowForTest",
  "isInsideInferenceLoop",
  "listActionLedgerRowsForTest",
  "listExtLogFiles",
  "readExtLogFile",
  "refreshPrompt",
  "removeDynamicContext",
  "setActionDelayForTest",
  "setActionGrantedPermissions",
  "setActionIdempotencyKey",
  "setActionLedgerPendingRetryLeaseForTest",
  "setActionLedgerRetentionForTest",
  "setBeforeStepAsyncDelay",
  "setBeforeToolCallAsync",
  "setBeforeToolCallThrows",
  "setContextBlock",
  "setEchoExecuteMode",
  "setReasoningResponse",
  "setResponse",
  "setSendReasoningDefault",
  "setStepModelOverride",
  "setToolCallDecision",
  "setTurnConfigOutputText",
  "setTurnConfigOverride",
  "setTurnConfigTransform",
  "stopAfterEchoToolCall",
  "sweepActionLedgerForTest",
  "testChat",
  "testSaveMessages",
  "useEchoActionForTest"
] as const;

type DispatchAgent = {
  __dispatchHooks(method: string, args: unknown[]): Promise<unknown>;
};

type ShellWithAgent = {
  withAgent<T>(fn: (agent: DispatchAgent) => T | Promise<T>): Promise<T>;
};

function installRpcMethods(target: { prototype: object }): void {
  for (const method of rpcMethodNames) {
    if (method in target.prototype) continue;
    Object.defineProperty(target.prototype, method, {
      value(this: ShellWithAgent, ...args: unknown[]) {
        return this.withAgent((agent) => agent.__dispatchHooks(method, args));
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasToolResult(request: ModelRequest): boolean {
  return request.messages.some((message) => message.role === "tool");
}

function countToolResults(messages: ModelRequest["messages"]): number {
  return messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "tool-result").length;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function missingFeature(message: string): never {
  throw new Error(message);
}

class CollectingCallback implements StreamCallback {
  events: string[] = [];
  done = false;
  error?: string;
  requestId?: string;

  onStart(info: { requestId: string }): void {
    this.requestId = info.requestId;
  }

  onEvent(json: unknown): void {
    this.events.push(typeof json === "string" ? json : JSON.stringify(json));
  }

  onDone(): void {
    this.done = true;
  }

  onError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
  }
}

function responseModel(host: AgentHost): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      host.store.put("hooks:last-model-settings", request.settings ?? {});
      const reasoning = host.store.get<{ text: string; reasoning: string }>(
        "hooks:reasoning-response"
      );
      if (reasoning) {
        yield { type: "reasoning-delta", text: reasoning.reasoning };
        yield { type: "text-delta", text: reasoning.text };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 }
        };
        return;
      }

      const response =
        host.store.get<string>("hooks:response") ?? "Hello from the assistant!";
      yield { type: "text-delta", text: response };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };
}

function echoToolModel(
  host: AgentHost,
  toolName = "echo",
  inputOverride?: JsonRecord
): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      host.store.put("hooks:last-model-settings", request.settings ?? {});
      if (!hasToolResult(request)) {
        yield {
          type: "tool-call",
          toolCallId:
            host.store.get<string>("hooks:next-tool-call-id") ?? "tc1",
          toolName,
          input:
            inputOverride ??
            (toolName === "ping"
              ? { msg: "hi" }
              : {
                  message:
                    host.store.get<string>("hooks:next-action-input") ??
                    "hello"
                })
        };
        yield { type: "finish", finishReason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: toolName === "ping" ? "done" : "done" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };
}

async function* echoIterator(message: string): AsyncIterable<string> {
  yield `echo-prelim-1: ${message}`;
  yield `echo-prelim-2: ${message}`;
  yield `echo: ${message}`;
}

class ThinkHooksBaseImpl extends Think {
  constructor(host: AgentHost) {
    super(host);
    this.beforeTurn = async (ctx) => {
      const log =
        this.host.store.get<JsonRecord[]>("hooks:before-turn-log") ?? [];
      log.push({
        system: this.getSystemPrompt(),
        continuation: ctx.continuation,
        toolNames: ["read", "write", ...Object.keys(this.getTools())],
        messageCount: ctx.messages.length
      });
      this.host.store.put("hooks:before-turn-log", log);
      this.host.store.put("hooks:captured-options", [
        ...(this.host.store.get<JsonRecord[]>("hooks:captured-options") ?? []),
        { continuation: ctx.continuation }
      ]);

      const raw = this.host.store.get<JsonRecord>("hooks:turn-config");
      const stopAfterEcho = this.host.store.get<boolean>(
        "hooks:stop-after-echo"
      );
      if (!raw && !stopAfterEcho) return undefined;
      const config: JsonRecord = { ...(raw ?? {}) };
      const settingsKeys = [
        "temperature",
        "maxOutputTokens",
        "topP",
        "topK",
        "seed",
        "stopSequences",
        "maxRetries",
        "headers",
        "providerOptions"
      ];
      const settings: JsonRecord = {};
      for (const key of settingsKeys) {
        if (key in config) {
          settings[key] = config[key];
          delete config[key];
        }
      }
      if (Object.keys(settings).length > 0) config.settings = settings;
      if (stopAfterEcho) {
        config.stopWhen = ({
          steps
        }: {
          steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
        }) =>
          steps.some((step) =>
            step.toolCalls.some((call) => call.toolName === "echo")
          );
      }
      return config;
    };

    this.beforeStep = async (ctx) => {
      const delay = this.host.store.get<number>("hooks:before-step-delay") ?? 0;
      if (delay > 0) await sleep(delay);
      const log =
        this.host.store.get<JsonRecord[]>("hooks:before-step-log") ?? [];
      log.push({
        stepNumber: ctx.stepNumber,
        previousStepCount: ctx.stepNumber,
        previousToolResultCount: countToolResults(ctx.messages),
        messageCount: ctx.messages.length,
        modelId: "mock-model"
      });
      this.host.store.put("hooks:before-step-log", log);
      const override = this.host.store.get<string>("hooks:step-model-override");
      return override ? { model: responseModelWithText(override) } : undefined;
    };

    this.beforeToolCall = async (ctx) => {
      const log =
        this.host.store.get<JsonRecord[]>("hooks:before-tool-log") ?? [];
      log.push({
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        inputJson: safeJson(ctx.input),
        stepNumber: ctx.stepNumber
      });
      this.host.store.put("hooks:before-tool-log", log);
      const throws = this.host.store.get<string>("hooks:before-tool-throws");
      if (throws) throw new Error(throws);
      if (this.host.store.get<boolean>("hooks:before-tool-async"))
        await sleep(5);
      return (
        this.host.store.get<JsonRecord | null>("hooks:tool-call-decision") ??
        undefined
      );
    };

    this.afterToolCall = (ctx) => {
      const log =
        this.host.store.get<JsonRecord[]>("hooks:after-tool-log") ?? [];
      // Fidelity: the original fixture logs `{ error: String(err) }` on
      // failure ("Error: policy violation" — assistant-agent-loop.ts
      // afterToolCall). Mirror that with the rebuild's ErrorValue fields.
      // (This branch was unreachable before ISSUE-033(c): a throwing
      // beforeToolCall used to propagate instead of firing afterToolCall.)
      const output = ctx.success
        ? ctx.output
        : { error: `${ctx.error.name}: ${ctx.error.message}` };
      log.push({
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        inputJson: safeJson(ctx.input),
        outputJson: safeJson(output),
        stepNumber: ctx.stepNumber,
        success: ctx.success
      });
      this.host.store.put("hooks:after-tool-log", log);
      const chunks =
        this.host.store.get<JsonRecord[]>("hooks:tool-result-chunks") ?? [];
      chunks.push({
        toolCallId: ctx.toolCallId,
        preliminary: false,
        outputJson: safeJson(output)
      });
      this.host.store.put("hooks:tool-result-chunks", chunks);
    };

    this.onStepFinish = (ctx) => {
      const log = this.host.store.get<JsonRecord[]>("hooks:step-log") ?? [];
      log.push({
        stepNumber: ctx.stepNumber,
        text: ctx.text,
        reasoning: ctx.reasoning,
        finishReason: ctx.finishReason,
        inputTokens: ctx.usage?.inputTokens,
        outputTokens: ctx.usage?.outputTokens,
        toolCallCount: ctx.toolCalls.length,
        toolResultCount: ctx.toolResults.length
      });
      this.host.store.put("hooks:step-log", log);
    };

    this.onChunk = ({ chunk }) => {
      this.host.store.put(
        "hooks:chunk-count",
        (this.host.store.get<number>("hooks:chunk-count") ?? 0) + 1
      );
      if (chunk.type === "text-delta") {
        this.host.store.put("hooks:last-text-delta", chunk.text);
      }
    };
  }

  protected override getSystemPrompt(): string {
    return [
      "You are a careful, capable assistant.",
      "You are running inside a Think agent.",
      "Use the agent workspace when it helps."
    ].join(" ");
  }

  protected override getModel(): ModelClient {
    return responseModel(this.host);
  }

  async __dispatchHooks(method: string, args: unknown[]): Promise<unknown> {
    const fn = (
      this as unknown as Record<string, (...a: unknown[]) => unknown>
    )[method];
    if (typeof fn !== "function")
      throw new Error(`fixture-gap: missing RPC method ${method}`);
    return await fn.apply(this, args);
  }

  async testChat(message: string): Promise<TestChatResult> {
    const cb = new CollectingCallback();
    const result = await this.chat(message, cb);
    return {
      events: cb.events,
      done:
        cb.done ||
        result.outcome === "completed" ||
        result.outcome === "suspended",
      ...(cb.error ? { error: cb.error } : {}),
      requestId: cb.requestId ?? result.requestId
    };
  }

  async testSaveMessages(messages: ChatMessage[]): Promise<TestChatResult> {
    const result = await this.saveMessages(messages);
    return {
      events: [],
      done: result.outcome === "completed",
      requestId: result.requestId
    };
  }

  async setResponse(response: string): Promise<void> {
    this.host.store.put("hooks:response", response);
  }

  async setReasoningResponse(text: string, reasoning: string): Promise<void> {
    this.host.store.put("hooks:reasoning-response", { text, reasoning });
  }

  async setSendReasoningDefault(value: boolean): Promise<void> {
    this.sendReasoning = value;
    this.host.store.put("hooks:send-reasoning", value);
  }

  async setTurnConfigOverride(config: JsonRecord): Promise<void> {
    this.host.store.put("hooks:turn-config", config);
  }

  async setTurnConfigOutputText(): Promise<void> {
    missingFeature(
      "missing-feature no-issue-yet: TurnConfig has no output field in the rebuild"
    );
  }

  async setTurnConfigTransform(): Promise<void> {
    missingFeature(
      "missing-feature no-issue-yet: TurnConfig has no experimental_transform field in the rebuild"
    );
  }

  async setStepModelOverride(text: string): Promise<void> {
    this.host.store.put("hooks:step-model-override", text);
  }

  async setBeforeStepAsyncDelay(ms: number): Promise<void> {
    this.host.store.put("hooks:before-step-delay", ms);
  }

  async getBeforeTurnLog(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:before-turn-log") ?? [];
  }

  async getCapturedOptions(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:captured-options") ?? [];
  }

  async getBeforeStepLog(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:before-step-log") ?? [];
  }

  async getStepLog(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:step-log") ?? [];
  }

  async getBeforeToolCallLog(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:before-tool-log") ?? [];
  }

  async getAfterToolCallLog(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:after-tool-log") ?? [];
  }

  async getChunkCount(): Promise<number> {
    return this.host.store.get<number>("hooks:chunk-count") ?? 0;
  }

  async getLastModelCallSettings(): Promise<JsonRecord> {
    return this.host.store.get<JsonRecord>("hooks:last-model-settings") ?? {};
  }

  override async getMessages(): Promise<ChatMessage[]> {
    return super.getMessages();
  }

  async getCachedMessagesForTest(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async hostWriteFile(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostReadFile(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostGetMessages(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostGetSessionInfo(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async isInsideInferenceLoop(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostDeleteFile(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostListFiles(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostSendMessage(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }
}

function responseModelWithText(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: "text-delta", text };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };
}

class ThinkHooksAgentImpl extends ThinkHooksBaseImpl {}

class ThinkHooksProgrammaticAgentImpl extends ThinkHooksBaseImpl {}

class ThinkHooksToolsAgentImpl extends ThinkHooksBaseImpl {
  override maxSteps = 3;
  private echoExecuteCount = 0;

  protected override getModel(): ModelClient {
    return echoToolModel(this.host);
  }

  override authorizeTurn = ():
    | true
    | { allowed: true; grantedPermissions: string[] } => {
    const granted = this.host.store.get<string[] | undefined>(
      "hooks:granted-permissions"
    );
    return granted === undefined
      ? true
      : { allowed: true, grantedPermissions: granted };
  };

  protected override getTools(): ToolSet {
    if (this.host.store.get<boolean>("hooks:echo-action")) return {};
    const mode =
      this.host.store.get<ExecuteMode>("hooks:echo-execute-mode") ?? "default";
    return {
      echo: tool({
        description: "Echo a message",
        inputSchema: z.object({ message: z.string() }),
        ...(mode === "needs-approval" ? { needsApproval: true } : {}),
        execute: async ({ message }: { message: string }, ctx) => {
          this.echoExecuteCount++;
          this.host.store.put(
            "hooks:echo-execute-count",
            this.echoExecuteCount
          );
          if (mode === "add-messages") {
            const session = await this.ensureSession();
            const message = {
              id: this.ids.newId("msg"),
              role: "user",
              parts: [{ type: "text", text: "mid-turn" }]
            } as const;
            await session.appendMessage(message);
            const history = await session.getHistory();
            this.host.store.put("hooks:mid-turn-add-probe", {
              insideLoop: false,
              persisted: history.some((entry) => entry.id === message.id)
            });
          }
          if (mode === "async-generator") {
            const chunks =
              this.host.store.get<JsonRecord[]>("hooks:tool-result-chunks") ??
              [];
            chunks.push({
              toolCallId: ctx.toolCallId,
              preliminary: true,
              outputJson: safeJson(`echo-prelim-1: ${message}`)
            });
            chunks.push({
              toolCallId: ctx.toolCallId,
              preliminary: true,
              outputJson: safeJson(`echo-prelim-2: ${message}`)
            });
            this.host.store.put("hooks:tool-result-chunks", chunks);
            return echoIterator(message);
          }
          if (mode === "async-iterable") return echoIterator(message);
          if (mode === "sync-iterable") return echoIterator(message);
          return `echo: ${message}`;
        }
      })
    };
  }

  protected override getActions(): Record<string, Action> {
    if (!this.host.store.get<boolean>("hooks:echo-action")) return {};
    const mode =
      this.host.store.get<EchoMode>("hooks:echo-action-mode") ?? "default";
    return {
      echo: action({
        name: "echo",
        description: "Echo a message back as an action",
        inputSchema: z.object({ message: z.string() }),
        ...(mode === "permission" || mode === "approval-permission"
          ? { permissions: ["echo:run"] }
          : {}),
        ...(mode === "function-policy"
          ? { permissions: () => ["echo:hello"] }
          : {}),
        ...(mode === "approval" ||
        mode === "approval-permission" ||
        mode === "ledger-approval" ||
        mode === "function-policy"
          ? {
              approval: true,
              approvalSummary: "Approve echo action",
              approvalRisk: "low" as const
            }
          : {}),
        ...(mode.startsWith("ledger")
          ? {
              idempotencyKey:
                this.host.store.get<string>("hooks:action-idempotency-key") ??
                "ledger-key"
            }
          : {}),
        ...(mode === "timeout" ? { timeoutMs: 5 } : {}),
        execute: async (
          { message }: { message: string },
          ctx
        ): Promise<unknown> => {
          const delay = this.host.store.get<number>("hooks:action-delay") ?? 0;
          if (delay > 0) await sleep(delay);
          const count = this.host.store.get<number>("hooks:action-count") ?? 0;
          this.host.store.put("hooks:action-count", count + 1);
          this.host.store.put("hooks:action-context", {
            requestId: ctx.requestId,
            toolCallId: ctx.toolCallId,
            messageCount: ctx.messages.length
          });
          if (mode === "throw") throw new Error("action failed");
          if (mode === "ledger-throw") throw new Error("ledger action failed");
          if (mode === "timeout") {
            await new Promise((_resolve, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () => reject(ctx.signal.reason),
                {
                  once: true
                }
              );
            });
          }
          if (mode === "large-output") return "x".repeat(30_000);
          if (mode === "non-json-output") {
            const payload: { count: bigint; self?: unknown } = { count: 12n };
            payload.self = payload;
            return payload;
          }
          if (mode === "ledger-symbol-output") return Symbol("test");
          return `action echo: ${message}`;
        }
      })
    };
  }

  async useEchoActionForTest(mode: EchoMode = "default"): Promise<void> {
    this.host.store.put("hooks:echo-action", true);
    this.host.store.put("hooks:echo-action-mode", mode);
  }

  async setActionGrantedPermissions(permissions: string[]): Promise<void> {
    this.host.store.put("hooks:granted-permissions", permissions);
  }

  async setActionIdempotencyKey(key: string | null): Promise<void> {
    if (key === null) this.host.store.delete("hooks:action-idempotency-key");
    else this.host.store.put("hooks:action-idempotency-key", key);
  }

  async setActionDelayForTest(ms: number): Promise<void> {
    this.host.store.put("hooks:action-delay", ms);
  }

  async setActionLedgerPendingRetryLeaseForTest(
    ms: number | false
  ): Promise<void> {
    this.actionLedgerPendingRetryLeaseMs = ms;
  }

  async setActionLedgerRetentionForTest(config: JsonRecord): Promise<void> {
    this.host.store.put("hooks:action-ledger-retention", config);
  }

  async setToolCallDecision(decision: JsonRecord | null): Promise<void> {
    this.host.store.put("hooks:tool-call-decision", decision);
  }

  async setBeforeToolCallAsync(value: boolean): Promise<void> {
    this.host.store.put("hooks:before-tool-async", value);
  }

  async setBeforeToolCallThrows(message: string): Promise<void> {
    this.host.store.put("hooks:before-tool-throws", message);
  }

  async setEchoExecuteMode(mode: ExecuteMode): Promise<void> {
    this.host.store.put("hooks:echo-execute-mode", mode);
  }

  async stopAfterEchoToolCall(): Promise<void> {
    this.host.store.put("hooks:stop-after-echo", true);
  }

  async executeEchoActionToolForTest(message = "hello"): Promise<unknown> {
    this.host.store.put("hooks:next-tool-call-id", "tc-direct");
    this.host.store.put("hooks:next-action-input", message);
    await this.clearMessages();
    try {
      await this.testChat(`direct ${message}`);
    } finally {
      this.host.store.delete("hooks:next-tool-call-id");
      this.host.store.delete("hooks:next-action-input");
    }
    const after = await this.getAfterToolCallLog();
    return JSON.parse(after.at(-1)?.outputJson ?? "null");
  }

  async executeEchoActionToolParallelForTest(): Promise<unknown[]> {
    this.host.store.put("hooks:next-tool-call-id", "tc-direct");
    await this.clearMessages();
    try {
      await Promise.all([
        this.testChat("parallel left"),
        this.testChat("parallel right")
      ]);
    } finally {
      this.host.store.delete("hooks:next-tool-call-id");
    }
    const after = await this.getAfterToolCallLog();
    return after.slice(-2).map((entry) => JSON.parse(String(entry.outputJson)));
  }

  async getActionProbe(): Promise<JsonRecord> {
    return {
      count: this.host.store.get<number>("hooks:action-count") ?? 0,
      context: this.host.store.get<JsonRecord>("hooks:action-context")
    };
  }

  async getEchoExecuteCount(): Promise<number> {
    return this.host.store.get<number>("hooks:echo-execute-count") ?? 0;
  }

  async getToolResultChunkLog(): Promise<JsonRecord[]> {
    return this.host.store.get<JsonRecord[]>("hooks:tool-result-chunks") ?? [];
  }

  async getMidTurnAddProbe(): Promise<JsonRecord> {
    return (
      this.host.store.get<JsonRecord>("hooks:mid-turn-add-probe") ?? {
        insideLoop: false,
        persisted: false
      }
    );
  }

  async insertActionLedgerRowForTest(row: JsonRecord): Promise<void> {
    const key = String(row.key ?? "");
    const internal = key
      .replace(/^action:/, "think:action:ledger:")
      .replace(/^tool:/, "think:action:ledger:echo:");
    this.host.store.put(internal, {
      status: row.status,
      inputHash: "ported-fixture",
      createdAt: row.updatedAt ?? Date.now(),
      ...(row.output !== undefined
        ? { output: row.output, settledAt: row.updatedAt ?? Date.now() }
        : {})
    });
  }

  async listActionLedgerRowsForTest(): Promise<JsonRecord[]> {
    return [
      ...this.host.store.list<JsonRecord>({ prefix: "think:action:ledger:" })
    ].map(([key, row]) => ({
      key: `action:${key.slice("think:action:ledger:".length)}`,
      action_name: key.slice("think:action:ledger:".length).split(":")[0],
      status: row.status,
      output: row.output,
      updated_at: row.settledAt ?? row.createdAt
    }));
  }

  async sweepActionLedgerForTest(): Promise<{
    settled: number;
    pending: number;
  }> {
    const config =
      this.host.store.get<JsonRecord>("hooks:action-ledger-retention") ?? {};
    const settledMs =
      typeof config.settledMs === "number" ? config.settledMs : 0;
    const pendingMs =
      typeof config.pendingMs === "number" ? config.pendingMs : 0;
    const now = Date.now();
    let settled = 0;
    let pending = 0;
    for (const [key, row] of this.host.store.list<JsonRecord>({
      prefix: "think:action:ledger:"
    })) {
      const updated = Number(row.settledAt ?? row.createdAt ?? now);
      if (row.status === "settled" && now - updated >= settledMs) {
        if (this.host.store.delete(key)) settled++;
      } else if (row.status === "pending" && now - updated >= pendingMs) {
        if (this.host.store.delete(key)) pending++;
      }
    }
    return { settled, pending };
  }
}

class ThinkHooksLoopToolAgentImpl extends ThinkHooksBaseImpl {
  override maxSteps = 3;

  protected override getModel(): ModelClient {
    return echoToolModel(this.host, "echo", { message: "ping" });
  }

  protected override getTools(): ToolSet {
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `pong: ${message}`
      })
    };
  }
}

class ThinkHooksSessionAgentImpl extends ThinkHooksBaseImpl {
  protected override configureSession(builder) {
    return builder.withContext("memory", { description: "Memory" });
  }

  async addDynamicContext(label: string, description?: string): Promise<void> {
    const session = await this.ensureSession();
    await session.addContext(label, { description });
    const labels = this.host.store.get<string[]>("hooks:context-labels") ?? [
      "memory"
    ];
    if (!labels.includes(label)) {
      labels.push(label);
      this.host.store.put("hooks:context-labels", labels);
    }
  }

  async removeDynamicContext(label: string): Promise<boolean> {
    const session = await this.ensureSession();
    const existing = await session.getContextBlock(label);
    session.removeContext(label);
    this.host.store.put(
      "hooks:context-labels",
      (
        this.host.store.get<string[]>("hooks:context-labels") ?? ["memory"]
      ).filter((entry) => entry !== label)
    );
    return existing !== undefined;
  }

  async getContextLabels(): Promise<string[]> {
    return this.host.store.get<string[]>("hooks:context-labels") ?? ["memory"];
  }

  async setContextBlock(label: string, content: string): Promise<void> {
    const session = await this.ensureSession();
    await session.replaceContextBlock(label, content);
  }

  async getContextBlockContent(label: string): Promise<string | null> {
    return (
      (await (await this.ensureSession()).getContextBlock(label))?.content ??
      null
    );
  }

  async getContextBlockDetails(label: string): Promise<JsonRecord | undefined> {
    return (await this.ensureSession()).getContextBlock(label);
  }

  async refreshPrompt(): Promise<string> {
    const prompt = await (await this.ensureSession()).refreshSystemPrompt();
    this.host.store.put("hooks:system-prompt", prompt);
    return prompt;
  }

  async getSystemPromptSnapshot(): Promise<string> {
    return (
      this.host.store.get<string>("hooks:system-prompt") ?? this.refreshPrompt()
    );
  }

  async getSessionToolNames(): Promise<string[]> {
    return Object.keys(await (await this.ensureSession()).tools());
  }

  async hostSetContext(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }

  async hostGetContext(): Promise<never> {
    missingFeature(HOOKS_HOST_BRIDGE_GAP);
  }
}

class ThinkHooksExtensionAgentImpl extends ThinkHooksLoopToolAgentImpl {
  async testChat(): Promise<never> {
    missingFeature(HOOKS_EXTENSION_GAP);
  }

  async listExtLogFiles(): Promise<never> {
    missingFeature(HOOKS_EXTENSION_GAP);
  }

  async readExtLogFile(): Promise<never> {
    missingFeature(HOOKS_EXTENSION_GAP);
  }
}

const ThinkHooksAgentBase = hostAgent(ThinkHooksAgentImpl);
const ThinkHooksProgrammaticAgentBase = hostAgent(
  ThinkHooksProgrammaticAgentImpl
);
const ThinkHooksToolsAgentBase = hostAgent(ThinkHooksToolsAgentImpl);
const ThinkHooksLoopToolAgentBase = hostAgent(ThinkHooksLoopToolAgentImpl);
const ThinkHooksSessionAgentBase = hostAgent(ThinkHooksSessionAgentImpl);
const ThinkHooksExtensionAgentBase = hostAgent(ThinkHooksExtensionAgentImpl);

export class ThinkHooksAgent extends ThinkHooksAgentBase {}
export class ThinkHooksProgrammaticAgent extends ThinkHooksProgrammaticAgentBase {}
export class ThinkHooksToolsAgent extends ThinkHooksToolsAgentBase {}
export class ThinkHooksLoopToolAgent extends ThinkHooksLoopToolAgentBase {}
export class ThinkHooksSessionAgent extends ThinkHooksSessionAgentBase {}
export class ThinkHooksExtensionAgent extends ThinkHooksExtensionAgentBase {}

installRpcMethods(ThinkHooksAgent);
installRpcMethods(ThinkHooksProgrammaticAgent);
installRpcMethods(ThinkHooksToolsAgent);
installRpcMethods(ThinkHooksLoopToolAgent);
installRpcMethods(ThinkHooksSessionAgent);
installRpcMethods(ThinkHooksExtensionAgent);
