/**
 * E2E test worker — Think agents for e2e testing.
 * TestAssistant: real Workers AI with workspace tools.
 * ThinkRecoveryE2EAgent: mock slow stream with chatRecovery for kill/restart testing.
 */
import { createWorkersAI } from "workers-ai-provider";
import { Agent, callable, routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { Think, Workspace } from "../think";
import { createBrowserTools } from "../tools/browser";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "../think";

type Env = {
  TestAssistant: DurableObjectNamespace<TestAssistant>;
  ThinkRecoveryE2EAgent: DurableObjectNamespace<ThinkRecoveryE2EAgent>;
  ThinkRecoveryHelperParent: DurableObjectNamespace<ThinkRecoveryHelperParent>;
  ThinkRecoveryHelperAgent: DurableObjectNamespace<ThinkRecoveryHelperAgent>;
  ThinkBrowserE2EAgent: DurableObjectNamespace<ThinkBrowserE2EAgent>;
  AI: Ai;
  R2: R2Bucket;
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
};

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
  override getMessages(): UIMessage[] {
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

type ExecutableTool<Input> = {
  execute(input: Input): unknown | Promise<unknown>;
};

function executableTool<Input>(
  tools: ToolSet,
  name: string
): ExecutableTool<Input> {
  const candidate = tools[name] as unknown;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("execute" in candidate) ||
    typeof candidate.execute !== "function"
  ) {
    throw new Error(`Tool ${name} is not executable`);
  }
  return candidate as ExecutableTool<Input>;
}

export class ThinkBrowserE2EAgent extends Think<Env> {
  override getModel(): LanguageModel {
    return createSlowE2EMockModel();
  }

  override getTools(): ToolSet {
    return {
      ...createBrowserTools({
        browser: this.env.BROWSER,
        loader: this.env.LOADER,
        session: {
          mode: "reuse",
          keepAliveMs: 600_000,
          liveView: true
        }
      })
    };
  }

  @callable()
  async executeBrowserTool(code: string): Promise<string> {
    const tool = executableTool<{ code: string }>(
      this.getTools(),
      "browser_execute"
    );
    const result = await tool.execute({ code });
    return String(result);
  }

  @callable()
  async browserSessionInfo(): Promise<string> {
    const tool = executableTool<Record<string, never>>(
      this.getTools(),
      "browser_session_info"
    );
    const result = await tool.execute({});
    return String(result);
  }

  @callable()
  async closeBrowserSession(): Promise<string> {
    const tool = executableTool<Record<string, never>>(
      this.getTools(),
      "browser_close_session"
    );
    const result = await tool.execute({});
    return String(result);
  }
}

export class ThinkRecoveryE2EAgent extends Think<Env> {
  override chatRecovery = true;

  private _recoveryContexts: Array<{
    streamId: string;
    requestId: string;
    partialText: string;
  }> = [];

  override getModel(): LanguageModel {
    return createSlowE2EMockModel();
  }

  override getSystemPrompt(): string {
    return "You are a test assistant for recovery testing.";
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this._recoveryContexts.push({
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      partialText: ctx.partialText
    });
    return { continue: false };
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
    const messages = this.getMessages();
    return {
      recoveryCount: this._recoveryContexts.length,
      contexts: this._recoveryContexts,
      messageCount: messages.length,
      assistantMessages: messages.filter((m) => m.role === "assistant").length
    };
  }

  @callable()
  async hasFiberRows(): Promise<boolean> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count > 0;
  }
}

export class ThinkRecoveryHelperAgent extends ThinkRecoveryE2EAgent {
  async startSlowTurn(prompt: string): Promise<string> {
    void this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }]
      }
    ]).catch(console.error);

    return "started";
  }
}

export class ThinkRecoveryHelperParent extends Agent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startHelperTurn(helperName: string, prompt: string): Promise<string> {
    const helper = await this.subAgent(ThinkRecoveryHelperAgent, helperName);
    return helper.startSlowTurn(prompt);
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
