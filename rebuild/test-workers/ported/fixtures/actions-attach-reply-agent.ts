import { z } from "zod";

import {
  Think,
  action,
  hostAgent,
  type Action,
  type ChatMessage,
  type ChatResponseResult,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type StreamCallback
} from "../compat.js";

type AttachScenario =
  | "two"
  | "none"
  | "invalid"
  | "non-json"
  | "overcap"
  | "approval-gated"
  | "predicate-noop"
  | "permission-noop"
  | "attach-then-throw";

type EchoMode = "attach-ledger" | "attach-idempotency-key" | "default";
type DurablePauseOptions = {
  approval?: "predicate-hello";
  attachReply?: boolean;
  idempotencyKey?: string;
};

function requestText(request: ModelRequest): string {
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

function pauseMessage(request: ModelRequest): string {
  const text = requestText(request);
  const match = /pauseAction\s+(.+)$/s.exec(text);
  return match?.[1]?.trim() || "hello";
}

function hasToolResult(request: ModelRequest): boolean {
  return request.messages.some((message) => message.role === "tool");
}

function attachModel(
  toolName: "attachAction" | "echo" | "pauseAction"
): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      if (!hasToolResult(request)) {
        yield {
          type: "tool-call",
          toolCallId:
            toolName === "attachAction"
              ? "ar1"
              : toolName === "echo"
                ? "tc1"
                : "dp1",
          toolName,
          input:
            toolName === "pauseAction"
              ? { message: pauseMessage(request) }
              : toolName === "echo"
                ? { message: "hello" }
                : {}
        };
        yield { type: "finish", finishReason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "attached-done" };
      yield { type: "finish", finishReason: "stop" };
    }
  };
}

class ThinkToolsTestAgentImpl extends Think {
  protected override getModel(): ModelClient {
    if (this.host.store.get<boolean>("test:durable-pause-action")) {
      return attachModel("pauseAction");
    }
    if (this.host.store.get<boolean>("test:echo-action")) {
      return attachModel("echo");
    }
    return attachModel("attachAction");
  }

  protected override getActions(): Record<string, Action> {
    const actions: Record<string, Action> = {};
    if (this.host.store.get<boolean>("test:attach-reply-action")) {
      const scenario =
        this.host.store.get<AttachScenario>("test:attach-scenario") ?? "two";
      actions.attachAction = action({
        name: "attachAction",
        description: "Attach delivery metadata to the final reply",
        inputSchema: z.object({}),
        ...(scenario === "approval-gated"
          ? {
              approval: true,
              approvalSummary: "Approve attach action",
              approvalRisk: "low" as const
            }
          : {}),
        ...(scenario === "predicate-noop" ? { approval: () => false } : {}),
        ...(scenario === "permission-noop"
          ? { permissions: () => ["attach:run"] }
          : {}),
        execute: async (_input: {}, ctx): Promise<unknown> => {
          if (scenario === "two") {
            ctx.attachReply({ type: "voice_note" });
            ctx.attachReply({ type: "card", payload: { id: 1 } });
          } else if (scenario === "invalid") {
            ctx.attachReply(null as unknown as { type: string });
            ctx.attachReply({} as unknown as { type: string });
            ctx.attachReply({ type: 123 } as unknown as { type: string });
          } else if (scenario === "non-json") {
            const payload: { big: bigint; self?: unknown } = { big: 1n };
            payload.self = payload;
            ctx.attachReply({ type: "card", payload });
          } else if (scenario === "overcap") {
            for (let i = 0; i < 40; i++) ctx.attachReply({ type: "x", i });
          } else if (scenario === "approval-gated") {
            ctx.attachReply({ type: "voice_note" });
          } else if (scenario === "attach-then-throw") {
            ctx.attachReply({ type: "voice_note" });
            throw new Error("attach action failed");
          }
          return "attached";
        }
      });
    }

    if (this.host.store.get<boolean>("test:echo-action")) {
      const mode = this.host.store.get<EchoMode>("test:echo-mode") ?? "default";
      actions.echo = action({
        name: "echo",
        description: "Echo a message back as an action",
        inputSchema: z.object({ message: z.string() }),
        idempotencyKey:
          mode === "attach-ledger" || mode === "attach-idempotency-key"
            ? (this.host.store.get<string>("test:action-idempotency-key") ??
              mode)
            : undefined,
        execute: async (
          { message }: { message: string },
          ctx
        ): Promise<unknown> => {
          const count = this.host.store.get<number>("test:action-count") ?? 0;
          this.host.store.put("test:action-count", count + 1);
          if (mode === "attach-ledger" || mode === "attach-idempotency-key") {
            ctx.attachReply({ type: "voice_note" });
          }
          return `action echo: ${message}`;
        }
      });
    }

    if (this.host.store.get<boolean>("test:durable-pause-action")) {
      const attachReply =
        this.host.store.get<boolean>("test:durable-attach-reply") ?? false;
      const approvalMode = this.host.store.get<DurablePauseOptions["approval"]>(
        "test:durable-approval-mode"
      );
      const idempotencyKey = this.host.store.get<string>(
        "test:durable-idempotency-key"
      );
      actions.pauseAction = action({
        name: "pauseAction",
        description: "A durable-pause action awaiting human approval",
        inputSchema: z.object({ message: z.string() }),
        kind: "durable-pause",
        approval:
          approvalMode === "predicate-hello"
            ? ({ input }) => (input as { message?: string }).message === "hello"
            : true,
        approvalSummary: "Approve pause action",
        approvalRisk: "high",
        permissions: ["pause:run"],
        idempotencyKey,
        execute: async (
          { message }: { message: string },
          ctx
        ): Promise<unknown> => {
          const count =
            this.host.store.get<number>("test:durable-pause-exec-count") ?? 0;
          this.host.store.put("test:durable-pause-exec-count", count + 1);
          if (attachReply) ctx.attachReply({ type: "voice_note" });
          return `paused-exec: ${message}`;
        }
      });
    }
    return actions;
  }

  override onChatResponse = async (
    result: import("../../../src/app/think.js").ChatResponseResult
  ): Promise<void> => {
    const log =
      this.host.store.get<ChatResponseResult[]>("test:response-log") ?? [];
    log.push({
      requestId: result.requestId,
      status: "completed",
      continuation: log.length > 0,
      message: result.message,
      attachments: result.attachments
    });
    this.host.store.put("test:response-log", log);
  };

  async useAttachReplyActionForTest(
    scenario: AttachScenario = "two"
  ): Promise<void> {
    this.host.store.put("test:attach-reply-action", true);
    this.host.store.put("test:attach-scenario", scenario);
  }

  async useEchoActionForTest(mode: EchoMode = "default"): Promise<void> {
    this.host.store.put("test:echo-action", true);
    this.host.store.put("test:echo-mode", mode);
  }

  async setActionIdempotencyKey(key: string | null): Promise<void> {
    if (key === null) this.host.store.delete("test:action-idempotency-key");
    else this.host.store.put("test:action-idempotency-key", key);
  }

  async testChat(message: string): Promise<{ done: boolean }> {
    let done = false;
    const callback: StreamCallback = {
      onStart() {},
      onEvent() {},
      onDone() {
        done = true;
      },
      onError() {}
    };
    const result = await this.chat(message, callback);
    return { done: done || result.outcome === "completed" };
  }

  async getResponseAttachmentsJson(): Promise<string> {
    const log =
      this.host.store.get<ChatResponseResult[]>("test:response-log") ?? [];
    return JSON.stringify(log.at(-1)?.attachments ?? []);
  }

  async getLastResponseRequestIdForTest(): Promise<string | null> {
    const log =
      this.host.store.get<ChatResponseResult[]>("test:response-log") ?? [];
    return log.at(-1)?.requestId ?? null;
  }

  async replyAttachmentsJsonForTest(requestId?: string): Promise<string> {
    return JSON.stringify(this.replyAttachments(requestId));
  }

  async clearResponseLogForTest(): Promise<void> {
    this.host.store.put<ChatResponseResult[]>("test:response-log", []);
  }

  async mutateLastResponseAttachmentForTest(): Promise<void> {
    const log =
      this.host.store.get<ChatResponseResult[]>("test:response-log") ?? [];
    const first = log.at(-1)?.attachments?.[0];
    if (first) first.type = "mutated";
    this.host.store.put("test:response-log", log);
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async getActionProbe(): Promise<{ count: number }> {
    return { count: this.host.store.get<number>("test:action-count") ?? 0 };
  }

  async useDurablePauseActionForTest(
    options?: DurablePauseOptions
  ): Promise<void> {
    this.host.store.put("test:durable-pause-action", true);
    this.host.store.put(
      "test:durable-attach-reply",
      options?.attachReply ?? false
    );
    if (options?.approval === undefined)
      this.host.store.delete("test:durable-approval-mode");
    else this.host.store.put("test:durable-approval-mode", options.approval);
    if (options?.idempotencyKey === undefined)
      this.host.store.delete("test:durable-idempotency-key");
    else
      this.host.store.put(
        "test:durable-idempotency-key",
        options.idempotencyKey
      );
  }

  async parkDurablePauseForTest(message = "hello"): Promise<unknown> {
    await this.chat(`pauseAction ${message}`);
    const messages = await this.getMessages();
    const toolPart = messages
      .flatMap((stored) => stored.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "dp1") as
      | { output?: unknown }
      | undefined;
    return toolPart?.output ?? {};
  }

  async approveExecutionForTest(executionId: string): Promise<unknown> {
    try {
      return await this.approveExecution(executionId);
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async rejectExecutionForTest(
    executionId: string,
    reason?: string
  ): Promise<unknown> {
    try {
      await this.rejectExecution(executionId, reason);
      return { status: "rejected", reason };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getDurablePauseExecCount(): Promise<number> {
    return this.host.store.get<number>("test:durable-pause-exec-count") ?? 0;
  }

  async listActionPendingForTest(): Promise<Array<Record<string, unknown>>> {
    return this.pendingApprovals().map((row) => ({
      action_name: row.descriptor.action,
      execution_id: row.executionId,
      descriptor_json: JSON.stringify(row.descriptor),
      created_at: row.createdAt
    }));
  }

  async pendingApprovalsForTest(): Promise<string> {
    return JSON.stringify(
      this.pendingApprovals().map((row) => ({
        executionId: row.executionId,
        source: "action",
        descriptor: row.descriptor
      }))
    );
  }

  async approveExecutionTwiceForTest(executionId: string): Promise<unknown[]> {
    return Promise.all([
      this.approveExecutionForTest(executionId),
      this.approveExecutionForTest(executionId)
    ]);
  }

  async removeDurablePauseActionForTest(): Promise<void> {
    this.host.store.delete("test:durable-pause-action");
  }

  async setActionPendingApprovalTtlForTest(_ttlMs: number): Promise<void> {
    this.host.store.put("test:durable-pause-ttl-configured", true);
  }

  async backdateActionPendingForTest(
    _executionId: string,
    _createdAt: number
  ): Promise<void> {
    this.host.store.put("test:durable-pause-backdate-requested", true);
  }

  async sweepActionPendingApprovalsForTest(): Promise<{ swept: number }> {
    return { swept: 0 };
  }

  async setDescribePausedExecutionForTest(
    override: Record<string, unknown>
  ): Promise<void> {
    this.host.store.put("test:paused-descriptor-override", override);
  }

  async descriptorForPausedOutputForTest(
    _requestId: string,
    _toolCallId: string,
    _output: unknown
  ): Promise<unknown> {
    return undefined;
  }
}

const ThinkToolsTestAgentBase = hostAgent(ThinkToolsTestAgentImpl);

export class ThinkToolsTestAgent extends ThinkToolsTestAgentBase {
  useAttachReplyActionForTest(scenario: AttachScenario = "two"): Promise<void> {
    return this.withAgent((agent) =>
      agent.useAttachReplyActionForTest(scenario)
    );
  }

  useEchoActionForTest(mode: EchoMode = "default"): Promise<void> {
    return this.withAgent((agent) => agent.useEchoActionForTest(mode));
  }

  setActionIdempotencyKey(key: string | null): Promise<void> {
    return this.withAgent((agent) => agent.setActionIdempotencyKey(key));
  }

  testChat(message: string): Promise<{ done: boolean }> {
    return this.withAgent((agent) => agent.testChat(message));
  }

  getResponseAttachmentsJson(): Promise<string> {
    return this.withAgent((agent) => agent.getResponseAttachmentsJson());
  }

  getLastResponseRequestIdForTest(): Promise<string | null> {
    return this.withAgent((agent) => agent.getLastResponseRequestIdForTest());
  }

  replyAttachmentsJsonForTest(requestId?: string): Promise<string> {
    return this.withAgent((agent) =>
      agent.replyAttachmentsJsonForTest(requestId)
    );
  }

  clearResponseLogForTest(): Promise<void> {
    return this.withAgent((agent) => agent.clearResponseLogForTest());
  }

  mutateLastResponseAttachmentForTest(): Promise<void> {
    return this.withAgent((agent) =>
      agent.mutateLastResponseAttachmentForTest()
    );
  }

  getStoredMessages(): Promise<ChatMessage[]> {
    return this.withAgent((agent) => agent.getStoredMessages());
  }

  getActionProbe(): Promise<{ count: number }> {
    return this.withAgent((agent) => agent.getActionProbe());
  }

  useDurablePauseActionForTest(options?: DurablePauseOptions): Promise<void> {
    return this.withAgent((agent) =>
      agent.useDurablePauseActionForTest(options)
    );
  }

  parkDurablePauseForTest(message = "hello"): Promise<unknown> {
    return this.withAgent((agent) => agent.parkDurablePauseForTest(message));
  }

  approveExecutionForTest(executionId: string): Promise<unknown> {
    return this.withAgent((agent) =>
      agent.approveExecutionForTest(executionId)
    );
  }

  rejectExecutionForTest(
    executionId: string,
    reason?: string
  ): Promise<unknown> {
    return this.withAgent((agent) =>
      agent.rejectExecutionForTest(executionId, reason)
    );
  }

  getDurablePauseExecCount(): Promise<number> {
    return this.withAgent((agent) => agent.getDurablePauseExecCount());
  }

  listActionPendingForTest(): Promise<Array<Record<string, unknown>>> {
    return this.withAgent((agent) => agent.listActionPendingForTest());
  }

  pendingApprovalsForTest(): Promise<string> {
    return this.withAgent((agent) => agent.pendingApprovalsForTest());
  }

  approveExecutionTwiceForTest(executionId: string): Promise<unknown[]> {
    return this.withAgent((agent) =>
      agent.approveExecutionTwiceForTest(executionId)
    );
  }

  removeDurablePauseActionForTest(): Promise<void> {
    return this.withAgent((agent) => agent.removeDurablePauseActionForTest());
  }

  setActionPendingApprovalTtlForTest(ttlMs: number): Promise<void> {
    return this.withAgent((agent) =>
      agent.setActionPendingApprovalTtlForTest(ttlMs)
    );
  }

  backdateActionPendingForTest(
    executionId: string,
    createdAt: number
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.backdateActionPendingForTest(executionId, createdAt)
    );
  }

  sweepActionPendingApprovalsForTest(): Promise<{ swept: number }> {
    return this.withAgent((agent) =>
      agent.sweepActionPendingApprovalsForTest()
    );
  }

  setDescribePausedExecutionForTest(
    override: Record<string, unknown>
  ): Promise<void> {
    return this.withAgent((agent) =>
      agent.setDescribePausedExecutionForTest(override)
    );
  }

  descriptorForPausedOutputForTest(
    requestId: string,
    toolCallId: string,
    output: unknown
  ): Promise<unknown> {
    return this.withAgent((agent) =>
      agent.descriptorForPausedOutputForTest(requestId, toolCallId, output)
    );
  }
}
