/**
 * Test agent for Think's built-in fetch-tools integration. Verifies that the
 * opt-in `fetchTools` property registers `fetch_url` in the assembled tool set
 * and that the capability prompt advertises it, while staying absent when
 * unconfigured. `beforeTurn` captures the assembled tools/system prompt.
 */
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import { streamText, type LanguageModel } from "ai";
import { Think } from "../../think";
import { createFetchTools, type FetchResult } from "../../tools/fetch";
import { WorkspaceFiles } from "../../workspace-files";
import type { StreamCallback, TurnContext } from "../../think";

const v3FinishReason = (unified: "stop" | "tool-calls") => ({
  unified,
  raw: undefined
});
const v3Usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens,
    cacheRead: 0,
    cacheWrite: 0
  },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
});

class CollectingCallback implements StreamCallback {
  doneCalled = false;
  errorMessage?: string;
  onStart(): void {}
  onEvent(): void {}
  onDone(): void {
    this.doneCalled = true;
  }
  onError(error: string): void {
    this.errorMessage = error;
  }
}

/** The tool definitions each model request carried, in order. */
type RequestTools = { name?: string }[] | undefined;

/** A tool result as a later model request carries it. */
type SeenResult = { role: string; content?: unknown };

/**
 * A model that answers "ok", or, while `call` is set and the request has no
 * tool result yet, asks for that one tool call. Every request's messages go
 * to `seen`.
 */
function createTextModel(
  requests: RequestTools[] = [],
  call?: () => { toolName: string; input: unknown } | undefined,
  seen: SeenResult[][] = []
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-fetch-tools",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: { tools?: { name?: string }[]; prompt?: SeenResult[] }) {
      requests.push(options.tools);
      seen.push(options.prompt ?? []);
      const wanted = call?.();
      const answered = options.prompt?.some((m) => m.role === "tool");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (wanted && !answered) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "fetch-1",
              toolName: wanted.toolName,
              input: JSON.stringify(wanted.input)
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
            controller.close();
            return;
          }
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, 5)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ThinkFetchToolsTestAgent extends Think {
  override maxSteps = 1;
  private _lastToolNames: string[] = [];
  private _lastSystem = "";
  readonly #requests: RequestTools[] = [];
  readonly #seen: SeenResult[][] = [];
  #call: { toolName: string; input: unknown } | undefined;

  override getModel(): LanguageModel {
    return createTextModel(this.#requests, () => this.#call, this.#seen);
  }

  /**
   * Have the model call `fetch_docs` on a binding that answers `body`, in
   * a turn: the tool result the next model request carries, as JSON.
   */
  async fetchThroughModel(body: string): Promise<string> {
    const binding = {
      fetch: async () =>
        new Response(body, { headers: { "content-type": "text/plain" } })
    } as unknown as Fetcher;
    this.fetchTools = {
      bindings: { docs: { binding, allowlist: ["/v1/docs/**"] } }
    };
    this.maxSteps = 2;
    this.#call = { toolName: "fetch_docs", input: { path: "/v1/docs/body" } };
    await this.chat("fetch it", new CollectingCallback());
    this.#call = undefined;
    const next = this.#seen.at(-1) ?? [];
    return JSON.stringify(next.filter((message) => message.role === "tool"));
  }

  /**
   * The tool definitions one turn sent to the model with fetch on, and the
   * same tools given straight to `streamText` (the workspace's, then the
   * fetch tools, as Think merges them): both as JSON.
   */
  async fetchToolRequests(): Promise<{ turn: string; direct: string }> {
    this.fetchTools = { allowlist: ["https://developers.cloudflare.com/**"] };
    await this.chat("hello", new CollectingCallback());
    const directRequests: RequestTools[] = [];
    await streamText({
      model: createTextModel(directRequests),
      tools: {
        ...createAITools({ workspace: this.workspace }),
        ...createFetchTools({ ...this.fetchTools, workspace: this.workspace })
      },
      prompt: "hello"
    }).consumeStream();
    return {
      turn: JSON.stringify(this.#requests.at(-1) ?? []),
      direct: JSON.stringify(directRequests[0] ?? [])
    };
  }

  override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  override beforeTurn(ctx: TurnContext): void {
    this._lastToolNames = Object.keys(ctx.tools);
    this._lastSystem = ctx.system;
  }

  /** Enable fetch tools with a public allowlist before the next turn. */
  async enableFetch(): Promise<void> {
    this.fetchTools = { allowlist: ["https://developers.cloudflare.com/**"] };
  }

  /** Run one turn and report the assembled tool names + system prompt. */
  async captureTurn(): Promise<{ toolNames: string[]; system: string }> {
    const cb = new CollectingCallback();
    await this.chat("hello", cb);
    return { toolNames: this._lastToolNames, system: this._lastSystem };
  }

  /**
   * Fetch one body through a binding into this agent's Workspace, then read
   * the stored file back as bytes.
   */
  async spillForTest(
    body: string | number[],
    contentType: string,
    request: { response?: "workspace"; spillToWorkspace?: boolean }
  ): Promise<{
    ok: boolean;
    response: string | null;
    path: string | null;
    stored: number[] | null;
  }> {
    await this.__unsafe_ensureInitialized();
    const binding = {
      fetch: async () =>
        new Response(typeof body === "string" ? body : new Uint8Array(body), {
          headers: { "content-type": contentType }
        })
    } as unknown as Fetcher;
    const tools = createFetchTools({
      bindings: { docs: { binding, allowlist: ["/v1/docs/**"] } },
      workspace: this.workspace,
      spillToWorkspace: request.spillToWorkspace ?? false
    });
    const execute = tools.fetch_docs?.execute;
    if (!execute) throw new Error("fetch_docs has no execute");
    const result = (await execute(
      {
        path: "/v1/docs/body",
        ...(request.response ? { response: request.response } : {})
      },
      { toolCallId: "test", messages: [], context: {} } as never
    )) as FetchResult;
    const stored =
      result.ok && result.path
        ? await new WorkspaceFiles(this.workspace).readBytes(result.path)
        : null;
    return {
      ok: result.ok,
      response: result.ok ? (result.response ?? null) : null,
      path: result.ok ? (result.path ?? null) : null,
      stored: stored === null ? null : Array.from(stored)
    };
  }
}
