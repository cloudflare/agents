import { z } from "zod";

import {
  Think,
  action,
  callable,
  hostAgent,
  type AgentHost,
  type Action,
  type ChatMessage,
  type ChatResponseResult,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type ToolPart,
} from "../compat.js";

type JsonRecord = Record<string, unknown>;

type StoredMessage = {
  message: ChatMessage;
  parentId: string | null;
};

type ExecuteOutputSnapshot = {
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

const ROOT = "__root__";

function textModel(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: "text-delta", text };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

function inputText(request: ModelRequest): string {
  return request.messages
    .flatMap((message) =>
      message.role === "user"
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
        : []
    )
    .join(" ");
}

function statusesInPrompt(request: ModelRequest): string[] {
  const serialized = JSON.stringify(request.messages);
  const statuses: string[] = [];
  const re = /"status"\s*:\s*"(completed|paused|rejected|error)"/g;
  for (const match of serialized.matchAll(re)) {
    const status = match[1];
    if (status !== undefined && !statuses.includes(status)) statuses.push(status);
  }
  return statuses;
}

function sessionKey(suffix: string): string {
  return `think:sess:main:${suffix}`;
}

function appendStoredMessage(host: AgentHost, message: ChatMessage): void {
  const leafKey = sessionKey("leaf");
  const parentId = host.store.get<string>(leafKey) ?? null;
  host.store.put<StoredMessage>(sessionKey(`msg:${message.id}`), {
    message,
    parentId,
  });

  const childrenKey = sessionKey(`children:${parentId ?? ROOT}`);
  const children = host.store.get<string[]>(childrenKey) ?? [];
  children.push(message.id);
  host.store.put(childrenKey, children);
  host.store.put(leafKey, message.id);
}

function replaceStoredMessage(host: AgentHost, message: ChatMessage): void {
  const key = sessionKey(`msg:${message.id}`);
  const existing = host.store.get<StoredMessage>(key);
  if (!existing) return;
  host.store.put<StoredMessage>(key, {
    message,
    parentId: existing.parentId,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotOutput(raw: unknown): ExecuteOutputSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as JsonRecord;
  const result = obj.result;
  return {
    status: typeof obj.status === "string" ? obj.status : undefined,
    executionId:
      typeof obj.executionId === "string" ? obj.executionId : undefined,
    result:
      result === null ||
      typeof result === "string" ||
      typeof result === "number" ||
      typeof result === "boolean"
        ? result
        : result === undefined
          ? undefined
          : JSON.stringify(result),
    error: typeof obj.error === "string" ? obj.error : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    pending: Array.isArray(obj.pending)
      ? obj.pending.map((entry) => {
          const pending = typeof entry === "object" && entry !== null
            ? (entry as JsonRecord)
            : {};
          return {
            connector:
              typeof pending.connector === "string" ? pending.connector : undefined,
            method: typeof pending.method === "string" ? pending.method : undefined,
            args:
              pending.args === undefined
                ? undefined
                : typeof pending.args === "string"
                  ? pending.args
                  : JSON.stringify(pending.args),
          };
        })
      : undefined,
  };
}

function firstTargetFromCode(code: string): string {
  return /target:\s*"([^"]+)"/.exec(code)?.[1] ?? "prod";
}

class TestAssistantAgentAgentImpl extends Think {
  protected override getModel(): ModelClient {
    return textModel("Hello from assistant");
  }
}

class ThinkClientToolsAgentImpl extends Think {
  protected override getModel(): ModelClient {
    return textModel("Hello from assistant");
  }

  async setTextOnlyMode(enabled: boolean): Promise<void> {
    this.host.store.put("test:text-only", enabled);
  }

  async persistToolCallMessage(messages: unknown[]): Promise<void> {
    for (const message of messages) {
      appendStoredMessage(this.host, message as ChatMessage);
    }
  }

  override onChatResponse = async (
    result: ChatResponseResult
  ): Promise<void> => {
    const log = this.host.store.get<Array<{ status: string }>>("test:response-log") ?? [];
    log.push({ status: result.outcome });
    this.host.store.put("test:response-log", log);
  };

  async getResponseLog(): Promise<Array<{ status: string }>> {
    return this.host.store.get<Array<{ status: string }>>("test:response-log") ?? [];
  }
}

class ThinkTestAgentImpl extends Think {
  private beforeStepDelayMs = 0;

  protected override getModel(): ModelClient {
    return {
      stream: async function* stream(request: ModelRequest): AsyncIterable<ModelChunk> {
        if (inputText(request).includes("resume")) {
          await new Promise<never>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          });
        }
        yield { type: "text-delta", text: "Hello from the assistant!" };
        yield { type: "finish", finishReason: "stop" };
      },
    };
  }

  override beforeStep = async (): Promise<void> => {
    if (this.beforeStepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.beforeStepDelayMs));
    }
  };

  async testStartResumableStream(requestId: string): Promise<string> {
    void this.chat("resume", undefined, { requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return requestId;
  }

  async testCompleteResumableStream(streamId: string): Promise<void> {
    this.cancelChat(streamId, "test complete");
  }

  async testStoreResumableChunk(streamId: string, body: string): Promise<void> {
    this.host.store.put(`test:stream:${streamId}:chunk`, body);
  }

  async recordTerminalForTest(requestId: string, body: string): Promise<void> {
    this.host.store.put("test:terminal", { requestId, body });
  }

  async getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return (
      this.host.store.get<{ requestId: string; body: string }>("test:terminal") ??
      null
    );
  }

  override async clearMessages(): Promise<void> {
    await super.clearMessages();
    this.host.store.delete("test:terminal");
  }

  async setBeforeStepAsyncDelay(ms: number): Promise<void> {
    this.beforeStepDelayMs = ms;
    this.host.store.put("test:before-step-delay", ms);
  }
}

class ThinkExecuteHitlAgentImpl extends Think {
  private codes = [`async () => await tools.deploy({ target: "prod" })`];

  executeCodes(): string[] {
    return this.codes;
  }

  async setExecuteCodes(codes: string[]): Promise<void> {
    this.codes = codes;
    this.host.store.put("test:execute-codes", codes);
  }

  protected override getModel(): ModelClient {
    return {
      stream: async function* stream(request: ModelRequest): AsyncIterable<ModelChunk> {
        const statuses = statusesInPrompt(request);
        if (statuses.length > 0) {
          yield { type: "text-delta", text: `seen:${statuses.join(",")}` };
          yield { type: "finish", finishReason: "stop" };
          return;
        }
        const rawCodes =
          request.messages.length > 0
            ? undefined
            : undefined;
        void rawCodes;
        yield {
          type: "tool-call",
          toolCallId: "tc-exec-1-0",
          toolName: "execute",
          input: { target: "prod" },
        };
        yield { type: "finish", finishReason: "tool-calls" };
      },
    };
  }

  protected override getActions(): Record<string, Action> {
    return {
      execute: action({
        name: "execute",
        description: "Execute approval-gated deployment code",
        kind: "durable-pause",
        approval: true,
        inputSchema: z.object({ target: z.string().optional() }),
        execute: (input: { target?: string }) => {
          const count = this.host.store.get<number>("test:gated-count") ?? 0;
          this.host.store.put("test:gated-count", count + 1);
          return `deployed:${input.target ?? "prod"}`;
        },
      }),
    };
  }

  async gatedCallCount(): Promise<number> {
    return this.host.store.get<number>("test:gated-count") ?? 0;
  }

  async executeParts(): Promise<ExecutePartSnapshot[]> {
    const out: ExecutePartSnapshot[] = [];
    for (const message of await this.getMessages()) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type !== "tool-execute") continue;
        const tool = part as ToolPart;
        out.push({
          toolCallId: tool.toolCallId,
          state: tool.state,
          output: snapshotOutput(tool.output),
        });
      }
    }
    return out;
  }

  async lastAssistantText(): Promise<string> {
    const messages = await this.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.length > 0) return text;
    }
    return "";
  }

  async stripExecutePartsForTest(): Promise<void> {
    for (const message of await this.getMessages()) {
      if (message.role !== "assistant") continue;
      const remaining = message.parts.filter((part) => part.type !== "tool-execute");
      if (remaining.length === message.parts.length) continue;
      replaceStoredMessage(this.host, {
        ...message,
        parts:
          remaining.length > 0
            ? remaining
            : [{ type: "text", text: "(summarized)" }],
      });
    }
  }

  async systemNoteTexts(): Promise<string[]> {
    return (await this.getMessages())
      .filter((message) => message.role === "system")
      .map((message) =>
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      );
  }

  async expirePausedForTest(): Promise<string[]> {
    return this.pendingApprovals().map((approval) => approval.executionId);
  }

  async dropCodemodeHandleForTest(): Promise<void> {
    this.host.store.put("test:codemode-dropped", true);
  }

  @callable()
  override async approveExecution(executionId: string): Promise<unknown> {
    try {
      const output = await super.approveExecution(executionId);
      return typeof output === "object" && output !== null
        ? output
        : { status: "completed", result: output };
    } catch (err) {
      return { status: "error", error: errorMessage(err) };
    }
  }

  @callable()
  override async rejectExecution(
    executionId: string,
    reason?: string
  ): Promise<void> {
    try {
      await super.rejectExecution(executionId, reason);
    } catch (err) {
      this.host.store.put("test:last-reject-error", errorMessage(err));
    }
  }

  @callable()
  pendingExecutions(executionId?: string): Array<{
    executionId: string;
    args?: unknown;
  }> {
    return this.pendingApprovals(executionId).map((approval) => ({
      executionId: approval.executionId,
      args: approval.input,
    }));
  }
}

const TestAssistantAgentAgentBase = hostAgent(TestAssistantAgentAgentImpl);
export class TestAssistantAgentAgent extends TestAssistantAgentAgentBase {
  getMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getMessages());
  }

  clearMessages(): Promise<void> {
    return this.withAgent((agent) => agent.clearMessages());
  }
}

const ThinkClientToolsAgentBase = hostAgent(ThinkClientToolsAgentImpl);
export class ThinkClientToolsAgent extends ThinkClientToolsAgentBase {
  setTextOnlyMode(enabled: boolean): Promise<void> {
    return this.withAgent((agent) => agent.setTextOnlyMode(enabled));
  }

  persistToolCallMessage(messages: unknown[]): Promise<void> {
    return this.withAgent((agent) => agent.persistToolCallMessage(messages));
  }

  getMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getMessages());
  }

  getResponseLog(): Promise<Array<{ status: string }>> {
    return this.withAgent((agent) => agent.getResponseLog());
  }
}

const ThinkTestAgentBase = hostAgent(ThinkTestAgentImpl);
export class ThinkTestAgent extends ThinkTestAgentBase {
  testStartResumableStream(requestId: string): Promise<string> {
    return this.withAgent((agent) => agent.testStartResumableStream(requestId));
  }

  testCompleteResumableStream(streamId: string): Promise<void> {
    return this.withAgent((agent) => agent.testCompleteResumableStream(streamId));
  }

  testStoreResumableChunk(streamId: string, body: string): Promise<void> {
    return this.withAgent((agent) => agent.testStoreResumableChunk(streamId, body));
  }

  recordTerminalForTest(requestId: string, body: string): Promise<void> {
    return this.withAgent((agent) => agent.recordTerminalForTest(requestId, body));
  }

  getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return this.withAgent((agent) => agent.getPendingChatTerminalForTest());
  }

  clearMessages(): Promise<void> {
    return this.withAgent((agent) => agent.clearMessages());
  }

  setBeforeStepAsyncDelay(ms: number): Promise<void> {
    return this.withAgent((agent) => agent.setBeforeStepAsyncDelay(ms));
  }
}

const ThinkExecuteHitlAgentBase = hostAgent(ThinkExecuteHitlAgentImpl);
export class ThinkExecuteHitlAgent extends ThinkExecuteHitlAgentBase {
  setExecuteCodes(codes: string[]): Promise<void> {
    return this.withAgent((agent) => agent.setExecuteCodes(codes));
  }

  executeParts(): Promise<ExecutePartSnapshot[]> {
    return this.withAgent((agent) => agent.executeParts());
  }

  lastAssistantText(): Promise<string> {
    return this.withAgent((agent) => agent.lastAssistantText());
  }

  gatedCallCount(): Promise<number> {
    return this.withAgent((agent) => agent.gatedCallCount());
  }

  stripExecutePartsForTest(): Promise<void> {
    return this.withAgent((agent) => agent.stripExecutePartsForTest());
  }

  systemNoteTexts(): Promise<string[]> {
    return this.withAgent((agent) => agent.systemNoteTexts());
  }

  expirePausedForTest(): Promise<string[]> {
    return this.withAgent((agent) => agent.expirePausedForTest());
  }

  dropCodemodeHandleForTest(): Promise<void> {
    return this.withAgent((agent) => agent.dropCodemodeHandleForTest());
  }
}
