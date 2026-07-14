import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LanguageModel } from "ai";
import { McpAgent } from "agents/mcp";
import { Session } from "agents/experimental/memory/session";
import type { SkillSource } from "agents/skills";
import { z } from "zod";
import { Think } from "../../think";
import type { StreamCallback } from "../../think";

const finishReason = (unified: "stop" | "tool-calls") => ({
  unified,
  raw: undefined
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

function createBashCallingModel(options: {
  code: string;
  resultMarker: string;
  onTools: (names: string[]) => void;
  onResult: () => void;
}): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "codemode-bash-mcp",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in test model");
    },
    doStream(callOptions: unknown) {
      const record = callOptions as {
        prompt?: unknown[];
        tools?: Array<{ name?: string }>;
      };
      options.onTools(
        (record.tools ?? [])
          .map((candidate) => candidate.name)
          .filter((name): name is string => typeof name === "string")
          .sort()
      );

      const promptJson = JSON.stringify(record.prompt ?? []);
      const hasResult = promptJson.includes(options.resultMarker);
      if (hasResult) options.onResult();

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (!hasResult) {
            controller.enqueue({
              type: "tool-input-start",
              id: "bash-call",
              toolName: "bash"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "bash-call",
              delta: JSON.stringify({ code: options.code })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "bash-call"
            });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "bash-call",
              toolName: "bash",
              input: JSON.stringify({ code: options.code })
            });
            controller.enqueue({
              type: "finish",
              finishReason: finishReason("tool-calls"),
              usage
            });
          } else {
            controller.enqueue({ type: "text-start", id: "final" });
            controller.enqueue({
              type: "text-delta",
              id: "final",
              delta: "MCP call completed"
            });
            controller.enqueue({ type: "text-end", id: "final" });
            controller.enqueue({
              type: "finish",
              finishReason: finishReason("stop"),
              usage
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

class CollectingCallback implements StreamCallback {
  done = false;
  error?: string;

  onStart(): void {}
  onEvent(): void {}
  onDone(): void {
    this.done = true;
  }
  onError(error: string): void {
    this.error = error;
  }
}

export class ThinkCodemodeBashMcpServer extends McpAgent {
  server = new McpServer({ name: "catalog", version: "1.0.0" });

  async init(): Promise<void> {
    for (let index = 0; index < 312; index++) {
      this.server.registerTool(
        `synthetic_${index}`,
        {
          description: `Synthetic complex catalog tool ${index}.`,
          inputSchema: {
            payload: z.object({
              query: z.string(),
              filters: z.array(
                z.object({
                  field: z.string(),
                  operation: z.enum(["eq", "contains", "prefix"]),
                  values: z.array(z.string())
                })
              ),
              options: z
                .object({
                  limit: z.number().int().min(1).max(100),
                  includeMetadata: z.boolean()
                })
                .optional()
            })
          },
          outputSchema: {
            result: z.object({
              id: z.number(),
              values: z.array(z.string()),
              metadata: z.object({
                source: z.string(),
                durationMs: z.number()
              })
            })
          }
        },
        async () => ({
          content: [{ type: "text", text: `synthetic:${index}` }],
          structuredContent: {
            result: {
              id: index,
              values: [],
              metadata: { source: "test", durationMs: 0 }
            }
          }
        })
      );
    }

    this.server.tool(
      "echo",
      "Echo a value from the MCP server.",
      { value: z.string() },
      async ({ value }) => ({
        content: [{ type: "text", text: `echo:${value}` }]
      })
    );
  }
}

export type CodemodeBashTurnResult = {
  done: boolean;
  error?: string;
  modelToolNames: string[];
  sawResult: boolean;
};

const testSkillSource: SkillSource = {
  id: "codemode-bash-test",
  fingerprint: "v1",
  async list() {
    return [
      {
        name: "test-skill",
        description: "A test skill loaded through Code Mode."
      }
    ];
  },
  async load(name) {
    return name === "test-skill"
      ? {
          name,
          description: "A test skill loaded through Code Mode.",
          body: "Follow the test skill instructions."
        }
      : null;
  }
};

const TEST_EXTENSION_SOURCE = `{
  tools: {
    echo: {
      description: "Echo through a loaded Think extension.",
      parameters: { value: { type: "string" } },
      required: ["value"],
      execute: async (args) => "extension:" + args.value
    }
  }
}`;

export class ThinkCodemodeBashAgent extends Think {
  override extensionLoader = this.env.LOADER;
  override fetchTools = {
    bindings: {
      fixture: {
        binding: (
          this.ctx.exports as unknown as {
            ThinkCodemodeBashFetchBinding: Fetcher;
          }
        ).ThinkCodemodeBashFetchBinding,
        allowlist: ["/test/**"],
        baseUrl: "https://fixture.local"
      }
    }
  };

  private modelToolNames: string[] = [];
  private bashCode = `async () => {
    const matches = await codemode.search("Echo a value");
    if (!matches.results.some((match) => match.path === "catalog.echo")) {
      throw new Error("catalog.echo was not discoverable");
    }
    const docs = await codemode.describe("catalog.echo");
    if (docs.path !== "catalog.echo" || !docs.types.includes("EchoInput")) {
      throw new Error("catalog.echo had no on-demand type documentation");
    }
    return await catalog.echo({ value: "hello" });
  }`;
  private resultMarker = "echo:hello";
  private sawResult = false;

  override configureSession(session: Session): Session {
    return session.withContext("memory", {
      description: "Writable test memory",
      maxTokens: 1000
    });
  }

  override getSkills(): SkillSource[] {
    return [testSkillSource];
  }

  override getExtensions() {
    return [
      {
        manifest: {
          name: "test-extension",
          version: "1.0.0",
          description: "Code Mode extension fixture"
        },
        source: TEST_EXTENSION_SOURCE
      }
    ];
  }

  override async onStart(): Promise<void> {
    await this.addMcpServer("catalog", this.env.ThinkCodemodeBashMcpServer, {
      id: "catalog"
    });
  }

  override getModel(): LanguageModel {
    return createBashCallingModel({
      code: this.bashCode,
      resultMarker: this.resultMarker,
      onTools: (names) => {
        this.modelToolNames = names;
      },
      onResult: () => {
        this.sawResult = true;
      }
    });
  }

  private async runBashTurn(message: string): Promise<CodemodeBashTurnResult> {
    this.modelToolNames = [];
    this.sawResult = false;
    const callback = new CollectingCallback();
    await this.chat(message, callback);
    return {
      done: callback.done,
      ...(callback.error ? { error: callback.error } : {}),
      modelToolNames: this.modelToolNames,
      sawResult: this.sawResult
    };
  }

  async runMcpBashTurn(): Promise<{
    done: boolean;
    error?: string;
    modelToolNames: string[];
    mcpToolCount: number;
    getAIToolsCalls: number;
    sawMcpResult: boolean;
  }> {
    this.bashCode = `async () => {
      const matches = await codemode.search("Echo a value");
      if (!matches.results.some((match) => match.path === "catalog.echo")) {
        throw new Error("catalog.echo was not discoverable");
      }
      const docs = await codemode.describe("catalog.echo");
      if (docs.path !== "catalog.echo" || !docs.types.includes("EchoInput")) {
        throw new Error("catalog.echo had no on-demand type documentation");
      }
      return await catalog.echo({ value: "hello" });
    }`;
    this.resultMarker = "echo:hello";
    let getAIToolsCalls = 0;
    const originalGetAITools = this.mcp.getAITools;
    this.mcp.getAITools = () => {
      getAIToolsCalls++;
      throw new Error("Think must not materialize direct MCP AI tools");
    };
    let result: CodemodeBashTurnResult;
    try {
      result = await this.runBashTurn("Call the catalog echo capability");
    } finally {
      this.mcp.getAITools = originalGetAITools;
    }
    return {
      done: result.done,
      ...(result.error ? { error: result.error } : {}),
      modelToolNames: result.modelToolNames,
      mcpToolCount: this.mcp.listTools({ serverId: "catalog" }).length,
      getAIToolsCalls,
      sawMcpResult: result.sawResult
    };
  }

  async runContextBashTurn(): Promise<{
    done: boolean;
    error?: string;
    modelToolNames: string[];
    sawContextResult: boolean;
  }> {
    this.bashCode =
      'async () => await context.set_context({ label: "memory", content: "remember this" })';
    this.resultMarker = "Written to memory";
    const result = await this.runBashTurn("Write to durable context");
    return {
      done: result.done,
      ...(result.error ? { error: result.error } : {}),
      modelToolNames: result.modelToolNames,
      sawContextResult: result.sawResult
    };
  }

  async getSkillCatalogPrompt(): Promise<string> {
    return this.session.freezeSystemPrompt();
  }

  async runSkillBashTurn(): Promise<{
    done: boolean;
    error?: string;
    modelToolNames: string[];
    sawSkillResult: boolean;
  }> {
    this.bashCode =
      'async () => await skills.activate_skill({ name: "test-skill" })';
    this.resultMarker = "Follow the test skill instructions.";
    const result = await this.runBashTurn("Activate the matching skill");
    return {
      done: result.done,
      ...(result.error ? { error: result.error } : {}),
      modelToolNames: result.modelToolNames,
      sawSkillResult: result.sawResult
    };
  }

  async runWorkspaceBashTurn(): Promise<{
    done: boolean;
    error?: string;
    modelToolNames: string[];
    sawWorkspaceResult: boolean;
  }> {
    await this.workspace.writeFile("/workspace-test.txt", "workspace-value");
    this.bashCode =
      'async () => await workspace.readFile({ path: "/workspace-test.txt" })';
    this.resultMarker = "workspace-value";
    const result = await this.runBashTurn("Read a workspace file");
    return {
      done: result.done,
      ...(result.error ? { error: result.error } : {}),
      modelToolNames: result.modelToolNames,
      sawWorkspaceResult: result.sawResult
    };
  }

  async runExtensionBashTurn(): Promise<{
    done: boolean;
    error?: string;
    modelToolNames: string[];
    sawExtensionResult: boolean;
  }> {
    this.bashCode =
      'async () => await extensions.test_extension_echo({ value: "hello" })';
    this.resultMarker = "extension:hello";
    const result = await this.runBashTurn("Call a loaded extension");
    return {
      done: result.done,
      ...(result.error ? { error: result.error } : {}),
      modelToolNames: result.modelToolNames,
      sawExtensionResult: result.sawResult
    };
  }

  async rebuildBuiltinBashRuntime(): Promise<boolean> {
    this.codemode = undefined;
    await this.pendingExecutions();
    return this.codemode !== undefined;
  }

  async captureDirectOptOutTools(): Promise<string[]> {
    const previous = this.workspaceBash;
    this.workspaceBash = false;
    let names: string[] = [];
    const previousCode = this.bashCode;
    const previousMarker = this.resultMarker;
    this.bashCode = "async () => null";
    this.resultMarker = "__never__";
    try {
      const result = await this.runBashTurn("Capture direct opt-out tools");
      names = result.modelToolNames;
    } finally {
      this.workspaceBash = previous;
      this.bashCode = previousCode;
      this.resultMarker = previousMarker;
    }
    return names;
  }

  async runFetchBashTurn(): Promise<{
    done: boolean;
    error?: string;
    modelToolNames: string[];
    sawFetchResult: boolean;
  }> {
    this.bashCode =
      'async () => await fetch.fetch_fixture({ path: "/test/resource" })';
    this.resultMarker = "fetch:/test/resource";
    const result = await this.runBashTurn("Fetch an allowlisted resource");
    return {
      done: result.done,
      ...(result.error ? { error: result.error } : {}),
      modelToolNames: result.modelToolNames,
      sawFetchResult: result.sawResult
    };
  }
}
