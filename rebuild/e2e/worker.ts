import { routeAgentRequest } from "../src/adapters/cloudflare/routing.js";
import { hostAgent } from "../src/adapters/cloudflare/shell.js";
import { Think } from "../src/app/think.js";
import { callable } from "../src/domain/runtime/rpc/callable.js";
import type { ChatMessage } from "../src/domain/messages/model.js";
import type { StoredEvent } from "../src/domain/events/log.js";
import type {
  ChatErrorContext,
  StreamCallback
} from "../src/app/think.js";
import type { TurnContext } from "../src/domain/turn/loop.js";
import type {
  ModelChunk,
  ModelClient,
  ModelRequest
} from "../src/ports/model.js";

type RecoveryContextLogEntry = {
  streamId: string;
  requestId: string;
  partialText: string;
};

type RecoveryStatus = {
  recoveryCount: number;
  contexts: RecoveryContextLogEntry[];
  messageCount: number;
  assistantMessages: number;
};

type AgentToolRunStatus = {
  runId: string;
  status: string;
  error: string | null;
};

const RECOVERY_CONTEXTS_KEY = "test:recovery-contexts";
const RECOVERY_BEHAVIOR_KEY = "test:recovery-behavior";
const BEFORE_TURN_ERROR_KEY = "test:before-turn-error";
const ON_ERROR_LOG_KEY = "test:on-error-log";
const ON_CHAT_ERROR_LOG_KEY = "test:on-chat-error-log";
const AGENT_TOOL_RUNS_KEY = "test:agent-tool-runs";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSlowE2EMockModel(): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (request.signal?.aborted) {
          throw new Error("aborted");
        }
        yield { type: "text-delta", text: `chunk${i + 1} ` };
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 }
      };
    }
  };
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function chunkTextFrom(stored: StoredEvent): string {
  const event = stored.event;
  if (event.type !== "chunk") return "";
  const chunk = event.chunk;
  return chunk.type === "text-delta" ? chunk.delta : "";
}

class ThinkRecoveryE2EAgentImpl extends Think {
  override chatRecovery = true;

  protected override getModel(): ModelClient {
    return createSlowE2EMockModel();
  }

  protected override getSystemPrompt(): string {
    return "You are a test assistant for recovery testing.";
  }

  override beforeTurn = async (_ctx: TurnContext): Promise<void> => {
    const error = this.host.store.get<string>(BEFORE_TURN_ERROR_KEY);
    if (!error) return;
    this.host.store.delete(BEFORE_TURN_ERROR_KEY);
    throw new Error(error);
  };

  override onChatRecovery = async (ctx: {
    requestId: string;
    incidentId: string;
    attempt: number;
  }): Promise<void> => {
    const contexts =
      this.host.store.get<RecoveryContextLogEntry[]>(RECOVERY_CONTEXTS_KEY) ??
      [];
    contexts.push({
      streamId: ctx.incidentId,
      requestId: ctx.requestId,
      partialText: this.partialTextFor(ctx.requestId)
    });
    this.host.store.put(RECOVERY_CONTEXTS_KEY, contexts);

    // The rebuilt recovery hook currently observes but does not decide
    // continue/stop; keep the original fixture knob persisted for triage.
    void (
      this.host.store.get<"continue" | "stop">(RECOVERY_BEHAVIOR_KEY) ??
      "stop"
    );
  };

  override onChatError = async (
    error: unknown,
    _ctx: ChatErrorContext
  ): Promise<void> => {
    const log = this.host.store.get<string[]>(ON_CHAT_ERROR_LOG_KEY) ?? [];
    const message = error instanceof Error ? error.message : String(error);
    this.host.store.put(ON_CHAT_ERROR_LOG_KEY, [...log, message]);
  };

  private partialTextFor(requestId: string): string {
    const read = this.events().read(0);
    if (read.kind === "gap") return "";
    return read.events
      .filter((stored) => {
        const event = stored.event;
        return event.type === "chunk" && event.requestId === requestId;
      })
      .map(chunkTextFrom)
      .join("");
  }

  @callable()
  async getRecoveryStatus(): Promise<RecoveryStatus> {
    const messages = await this.getMessages();
    const contexts =
      this.host.store.get<RecoveryContextLogEntry[]>(RECOVERY_CONTEXTS_KEY) ??
      [];
    return {
      recoveryCount: contexts.length,
      contexts,
      messageCount: messages.length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length
    };
  }

  @callable()
  async setRecoveryBehavior(behavior: "continue" | "stop"): Promise<void> {
    this.host.store.put(RECOVERY_BEHAVIOR_KEY, behavior);
  }

  @callable()
  async throwBeforeNextTurn(message: string): Promise<void> {
    this.host.store.put(BEFORE_TURN_ERROR_KEY, message);
  }

  @callable()
  async getOnErrorLog(): Promise<string[]> {
    return this.host.store.get<string[]>(ON_ERROR_LOG_KEY) ?? [];
  }

  @callable()
  async getOnChatErrorLog(): Promise<string[]> {
    return this.host.store.get<string[]>(ON_CHAT_ERROR_LOG_KEY) ?? [];
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    return this.listFibers({
      name: "chat-turn",
      status: ["pending", "running", "interrupted"]
    }).length > 0;
  }

  @callable()
  async inspectRun(_runId: string): Promise<{
    status: string;
    output?: string;
    error?: string;
  } | null> {
    const hasFibers = await this.hasFiberRows();
    const messages = await this.getMessages();
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map(textOf)
      .join("");
    if (assistantText.length > 0 && !hasFibers) {
      return { status: "completed", output: assistantText };
    }
    if (hasFibers) return { status: "running" };
    return null;
  }
}

class ThinkRecoveryHelperAgentImpl extends ThinkRecoveryE2EAgentImpl {}

class ThinkRecoveryHelperParentImpl extends Think {
  protected override getModel(): ModelClient {
    return createSlowE2EMockModel();
  }

  @callable()
  async startHelperChatTurn(
    helperName: string,
    prompt: string
  ): Promise<string> {
    const helper = this.subAgent("ThinkRecoveryHelperAgent", helperName);

    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    const callback: StreamCallback = {
      onStart: () => {},
      onEvent: (event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "text-delta"
        ) {
          markReady();
        }
      },
      onDone: () => markReady(),
      onError: (error: unknown) => {
        markReady();
        console.error("[test] helper chat callback error:", error);
      }
    };

    void helper.call("chat", [prompt, callback]).catch(console.error);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race<void>([
        ready,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for helper chat chunk")),
            5000
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    return "started";
  }

  @callable()
  async startHelperAgentToolRun(
    runId: string,
    prompt: string
  ): Promise<string> {
    const child = this.subAgent("ThinkRecoveryHelperAgent", runId);
    await child.call("setRecoveryBehavior", ["continue"]);
    this.putAgentToolRun({ runId, status: "running", error: null });

    const callback: StreamCallback = {
      onStart: () => {},
      onEvent: () => {},
      onDone: () => {
        this.putAgentToolRun({ runId, status: "completed", error: null });
      },
      onError: (error: unknown) => {
        this.putAgentToolRun({
          runId,
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      },
      onInterrupted: () => {}
    };

    void child.call("chat", [prompt, callback]).catch((error: unknown) => {
      this.putAgentToolRun({
        runId,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return runId;
  }

  @callable()
  async getAgentToolRuns(): Promise<AgentToolRunStatus[]> {
    const rows = this.agentToolRuns();
    const next: AgentToolRunStatus[] = [];
    for (const row of rows) {
      if (row.status !== "running") {
        next.push(row);
        continue;
      }
      const observed = await this.subAgent(
        "ThinkRecoveryHelperAgent",
        row.runId
      ).call<{ status: string; output?: string; error?: string } | null>(
        "inspectRun",
        [row.runId]
      );
      if (observed?.status === "completed") {
        next.push({ runId: row.runId, status: "completed", error: null });
      } else if (observed?.status === "error") {
        next.push({
          runId: row.runId,
          status: "error",
          error: observed.error ?? "child reported failure"
        });
      } else {
        next.push(row);
      }
    }
    this.host.store.put(AGENT_TOOL_RUNS_KEY, next);
    return next;
  }

  @callable()
  async helperHasFiberRows(helperName: string): Promise<boolean> {
    return this.subAgent("ThinkRecoveryHelperAgent", helperName).call<boolean>(
      "hasFiberRows",
      []
    );
  }

  @callable()
  async getHelperRecoveryStatus(helperName: string): Promise<RecoveryStatus> {
    return this.subAgent("ThinkRecoveryHelperAgent", helperName).call(
      "getRecoveryStatus",
      []
    );
  }

  private agentToolRuns(): AgentToolRunStatus[] {
    return this.host.store.get<AgentToolRunStatus[]>(AGENT_TOOL_RUNS_KEY) ?? [];
  }

  private putAgentToolRun(row: AgentToolRunStatus): void {
    const rows = this.agentToolRuns().filter((entry) => entry.runId !== row.runId);
    rows.push(row);
    this.host.store.put(AGENT_TOOL_RUNS_KEY, rows);
  }
}

const ThinkRecoveryE2EAgentBase = hostAgent(ThinkRecoveryE2EAgentImpl);
export class ThinkRecoveryE2EAgent extends ThinkRecoveryE2EAgentBase {}

const ThinkRecoveryHelperAgentBase = hostAgent(ThinkRecoveryHelperAgentImpl);
export class ThinkRecoveryHelperAgent extends ThinkRecoveryHelperAgentBase {}

const ThinkRecoveryHelperParentBase = hostAgent(
  ThinkRecoveryHelperParentImpl
);
export class ThinkRecoveryHelperParent extends ThinkRecoveryHelperParentBase {}

function normalizeOriginalAcronymSlug(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/agents/think-recovery-e2-e-agent/")) {
    url.pathname = url.pathname.replace(
      "/agents/think-recovery-e2-e-agent/",
      "/agents/ThinkRecoveryE2EAgent/"
    );
    return new Request(url, request);
  }
  return request;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const normalized = normalizeOriginalAcronymSlug(request);
    return (
      (await routeAgentRequest(normalized, env)) ??
      new Response("rebuild e2e test worker")
    );
  }
};
