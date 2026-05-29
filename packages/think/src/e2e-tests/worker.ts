/**
 * E2E test worker — Think agents for e2e testing.
 * TestAssistant: real Workers AI with workspace tools.
 * ThinkRecoveryE2EAgent: mock slow stream with chatRecovery for kill/restart testing.
 */
import { createWorkersAI } from "workers-ai-provider";
import { Agent, callable, routeAgentRequest } from "agents";
import { RpcTarget } from "cloudflare:workers";
import type { LanguageModel, UIMessage } from "ai";
import { Think, Workspace } from "../think";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions,
  StreamCallback,
  TurnConfig,
  TurnContext
} from "../think";

type Env = {
  TestAssistant: DurableObjectNamespace<TestAssistant>;
  ThinkRecoveryE2EAgent: DurableObjectNamespace<ThinkRecoveryE2EAgent>;
  ThinkRecoveryHelperParent: DurableObjectNamespace<ThinkRecoveryHelperParent>;
  ThinkRecoveryHelperAgent: DurableObjectNamespace<ThinkRecoveryHelperAgent>;
  AI: Ai;
  R2: R2Bucket;
};

type RecoveryContextLogEntry = {
  streamId: string;
  requestId: string;
  partialText: string;
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

export class TestAssistant extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  getSystemPrompt(): string {
    return `You are a helpful assistant with access to a workspace filesystem.
You can read, write, edit, find, grep, and delete files.
When asked to write a file, use the write tool. When asked to read a file, use the read tool.
Always respond concisely.`;
  }

  @callable()
  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}

/**
 * Slow mock model that streams chunks with delays — used for kill/restart
 * testing. The model takes long enough that SIGKILL will interrupt it.
 */
function createSlowE2EMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-slow-e2e",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t-slow" });
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            controller.enqueue({
              type: "text-delta",
              id: "t-slow",
              delta: `chunk${i + 1} `
            });
          }
          controller.enqueue({ type: "text-end", id: "t-slow" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 20 }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ThinkRecoveryE2EAgent extends Think<Env> {
  override chatRecovery = true;

  override getModel(): LanguageModel {
    return createSlowE2EMockModel();
  }

  override getSystemPrompt(): string {
    return "You are a test assistant for recovery testing.";
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    const contexts =
      (await this.ctx.storage.get<RecoveryContextLogEntry[]>(
        RECOVERY_CONTEXTS_KEY
      )) ?? [];
    contexts.push({
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      partialText: ctx.partialText
    });
    await this.ctx.storage.put(RECOVERY_CONTEXTS_KEY, contexts);

    const behavior =
      (await this.ctx.storage.get<"continue" | "stop">(
        RECOVERY_BEHAVIOR_KEY
      )) ?? "stop";
    return { continue: behavior === "continue" };
  }

  override async beforeTurn(_ctx: TurnContext): Promise<TurnConfig | void> {
    const error = await this.ctx.storage.get<string>(BEFORE_TURN_ERROR_KEY);
    if (!error) return;
    await this.ctx.storage.delete(BEFORE_TURN_ERROR_KEY);
    throw new Error(error);
  }

  override async onError(error: unknown): Promise<void> {
    const log = (await this.ctx.storage.get<string[]>(ON_ERROR_LOG_KEY)) ?? [];
    log.push(error instanceof Error ? error.message : String(error));
    await this.ctx.storage.put(ON_ERROR_LOG_KEY, log);
  }

  override onChatError(error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error);
    this.ctx.storage
      .get<string[]>(ON_CHAT_ERROR_LOG_KEY)
      .then((log = []) =>
        this.ctx.storage.put(ON_CHAT_ERROR_LOG_KEY, [...log, message])
      )
      .catch(console.error);
    return error;
  }

  @callable()
  async getRecoveryStatus(): Promise<{
    recoveryCount: number;
    contexts: Array<{
      streamId: string;
      requestId: string;
      partialText: string;
    }>;
    messageCount: number;
    assistantMessages: number;
  }> {
    const messages = await this.getMessages();
    const contexts =
      (await this.ctx.storage.get<RecoveryContextLogEntry[]>(
        RECOVERY_CONTEXTS_KEY
      )) ?? [];
    return {
      recoveryCount: contexts.length,
      contexts,
      messageCount: messages.length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length
    };
  }

  @callable()
  async setRecoveryBehavior(behavior: "continue" | "stop"): Promise<void> {
    await this.ctx.storage.put(RECOVERY_BEHAVIOR_KEY, behavior);
  }

  @callable()
  async throwBeforeNextTurn(message: string): Promise<void> {
    await this.ctx.storage.put(BEFORE_TURN_ERROR_KEY, message);
  }

  @callable()
  async getOnErrorLog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(ON_ERROR_LOG_KEY)) ?? [];
  }

  @callable()
  async getOnChatErrorLog(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(ON_CHAT_ERROR_LOG_KEY)) ?? [];
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count > 0;
  }
}

export class ThinkRecoveryHelperAgent extends ThinkRecoveryE2EAgent {}

export class ThinkRecoveryHelperParent extends Agent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startHelperChatTurn(
    helperName: string,
    prompt: string
  ): Promise<string> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);

    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    class HelperChatCallback extends RpcTarget implements StreamCallback {
      onStart(): void {
        // The RPC callback surface is fixed; this test only waits for chunks.
      }

      onEvent(json: string): void {
        try {
          const chunk = JSON.parse(json) as { type?: string; delta?: string };
          if (chunk.type === "text-delta" && chunk.delta) {
            markReady();
          }
        } catch {
          // Ignore malformed test chunks.
        }
      }

      onDone(): void {
        markReady();
      }

      onError(error: string): void {
        markReady();
        console.error("[test] helper chat callback error:", error);
      }
    }

    const callback = new HelperChatCallback();
    void helper.chat(prompt, callback).catch(console.error);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race<void>([
        ready,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for helper chat chunk")),
            5_000
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
    return "started";
  }

  @callable()
  async startHelperAgentToolRun(
    runId: string,
    prompt: string
  ): Promise<string> {
    void this.runAgentTool(ThinkRecoveryHelperAgent, {
      runId,
      input: prompt
    }).catch((error) => {
      console.error("[test] helper agent-tool run failed:", error);
    });

    for (let i = 0; i < 20; i++) {
      const rows = this.getAgentToolRuns();
      if (rows.some((row) => row.runId === runId)) return runId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timed out waiting for helper agent-tool row");
  }

  @callable()
  getAgentToolRuns(): AgentToolRunStatus[] {
    return this.sql<AgentToolRunStatus>`
      SELECT run_id as runId, status, error_message as error
      FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;
  }

  @callable()
  async helperHasFiberRows(helperName: string): Promise<boolean> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);
    return helper.hasFiberRows();
  }

  @callable()
  async getHelperRecoveryStatus(helperName: string): Promise<{
    recoveryCount: number;
    contexts: Array<{
      streamId: string;
      requestId: string;
      partialText: string;
    }>;
    messageCount: number;
    assistantMessages: number;
  }> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);
    return helper.getRecoveryStatus();
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
