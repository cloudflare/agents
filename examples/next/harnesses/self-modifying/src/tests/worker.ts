import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult
} from "@ai-sdk/provider";
import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { HarnessBuildError } from "../harness-runtime";
import type { JsonObject, JsonValue } from "../json";
import type {
  HarnessRevision,
  HarnessSnapshot,
  HarnessTurn,
  HarnessTurnReceipt
} from "../protocol";
import { toJsonValue } from "../json";
import type {
  HarnessInferenceResult,
  HarnessMessage,
  HarnessModelRequest,
  HarnessToolCall,
  HarnessToolDefinition
} from "../runtime-types";
import { SelfModifyingHarness } from "../self-modifying-harness";

const CREATED_TOOL_SOURCE = `import type { CustomTool } from "../types";

export const greetCreatedTool: CustomTool = {
  definition: {
    name: "greet_created",
    description: "Return a greeting proving the newly activated tool ran.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    }
  },

  execute(input) {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input
      : {};
    return { greeting: "created tool works for " + String(record.name ?? "friend") };
  }
};
`;

const TEST_USAGE = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1
  }
};

function requestedTool(
  request: HarnessModelRequest,
  name: string,
  input: JsonValue
): HarnessInferenceResult {
  if (!request.tools.some((definition) => definition.name === name)) {
    return {
      text: `tool not available: ${name}`,
      finishReason: "stop",
      toolCalls: []
    };
  }
  const call: HarnessToolCall = {
    callId: `test-${request.round}-${name}`,
    name,
    input
  };
  return { text: "", finishReason: "tool-calls", toolCalls: [call] };
}

function lastUserMessage(request: HarnessModelRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function decide(request: HarnessModelRequest): HarnessInferenceResult {
  const latest = lastUserMessage(request);
  const turnPrompt = request.messages
    .filter(
      (message) =>
        message.role === "user" && !message.content.startsWith("Tool ")
    )
    .at(-1)?.content;

  if (turnPrompt === "Create and activate a greeting tool") {
    const actions: ReadonlyArray<readonly [string, JsonValue]> = [
      ["list_files", {}],
      ["read_file", { path: "src/tools/describe-self.ts" }],
      [
        "write_file",
        { path: "src/tools/greet-created.ts", content: CREATED_TOOL_SOURCE }
      ],
      ["activate_harness", { note: "add greet_created Custom tool" }]
    ];
    const action = actions[request.round - 1];
    if (action) return requestedTool(request, action[0], action[1]);
    return {
      text: "Created greet_created and activated the next revision.",
      finishReason: "stop",
      toolCalls: []
    };
  }

  if (turnPrompt === "Use greet_created" && request.round === 1) {
    return requestedTool(request, "greet_created", { name: "production" });
  }

  const toolMatch = latest.match(/^!tool\s+([^\s]+)\s+([\s\S]+)$/);
  if (toolMatch && request.round === 1) {
    const name = toolMatch[1];
    const input = toolMatch[2];
    if (name && input) {
      return requestedTool(request, name, toJsonValue(JSON.parse(input)));
    }
  }

  if (latest.startsWith("Tool ")) {
    return {
      text: `completed ${latest}`,
      finishReason: "stop",
      toolCalls: []
    };
  }

  const persona = request.system.match(/^PERSONA:\s*(.+)$/m)?.[1] ?? "unknown";
  return {
    text: `${persona}: ${latest}`,
    finishReason: "stop",
    toolCalls: []
  };
}

function textContent(
  message: LanguageModelV4CallOptions["prompt"][number]
): string {
  if (message.role === "system") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function schemaObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("Test LanguageModelV4 received a non-object tool schema");
  }
  return json;
}

function modelRequest(
  options: LanguageModelV4CallOptions
): HarnessModelRequest {
  const system = options.prompt
    .filter((message) => message.role === "system")
    .map(textContent)
    .join("\n");
  const messages: HarnessMessage[] = options.prompt.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    return [{ role: message.role, content: textContent(message) }];
  });
  const tools: HarnessToolDefinition[] = (options.tools ?? []).flatMap(
    (definition) =>
      definition.type === "function"
        ? [
            {
              name: definition.name,
              description: definition.description ?? "",
              inputSchema: schemaObject(definition.inputSchema)
            }
          ]
        : []
  );
  return {
    round:
      messages.filter(
        (message) =>
          message.role === "user" && message.content.startsWith("Tool ")
      ).length + 1,
    system,
    messages,
    tools
  };
}

function generateResult(
  result: HarnessInferenceResult
): LanguageModelV4GenerateResult {
  return {
    content: [
      ...(result.text === ""
        ? []
        : [{ type: "text" as const, text: result.text }]),
      ...result.toolCalls.map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.callId,
        toolName: call.name,
        input: JSON.stringify(call.input)
      }))
    ],
    finishReason: {
      unified: result.finishReason === "tool-calls" ? "tool-calls" : "stop",
      raw: result.finishReason
    },
    usage: TEST_USAGE,
    warnings: []
  };
}

class TestLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "self-modifying-harness-test";
  readonly modelId = "deterministic";
  readonly supportedUrls = {};

  doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    return Promise.resolve(generateResult(decide(modelRequest(options))));
  }

  doStream(): never {
    throw new Error("Test LanguageModelV4 is generate-only");
  }
}

/** Test-only Durable Object with a deterministic LanguageModelV4. */
export class TestSelfModifyingHarnessObject extends DurableObject<Env> {
  private readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "self_modifying"
  });
  private readonly tasks = new Tasks();
  private readonly streams = new Streams();
  private readonly harness = new SelfModifyingHarness({
    tasks: this.tasks,
    streams: this.streams,
    workspace: this.workspace,
    loader: this.env.LOADER,
    model: new TestLanguageModel()
  });
  private readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /** The snapshot without the recursive JSON journal, which RPC typing chokes on. */
  async snapshot(): Promise<TestSnapshot> {
    const { journal: _journal, ...rest } = await this.harness.snapshot();
    return rest;
  }

  /** Admit and run a turn to settlement in this invocation. */
  prompt(text: string): Promise<HarnessTurn> {
    return this.harness.prompt(text);
  }

  /** Admit a turn for queued execution and return its receipt. */
  submit(text: string, turnId: string): Promise<HarnessTurnReceipt> {
    return this.harness.submit(text, turnId);
  }

  turn(turnId: string): Promise<HarnessTurn | null> {
    return this.harness.getTurn(turnId);
  }

  async writeSource(path: string, content: string): Promise<Outcome<null>> {
    try {
      await this.harness.writeSource(path, content);
      return { ok: true, value: null };
    } catch (error) {
      return failure(error);
    }
  }

  async activate(note: string): Promise<Outcome<HarnessRevision>> {
    try {
      return { ok: true, value: await this.harness.activate(note) };
    } catch (error) {
      return failure(error);
    }
  }

  restore(revisionId: number): Promise<HarnessRevision> {
    return this.harness.restore(revisionId);
  }

  /** Every event type appended to one turn's durable stream, in order. */
  async streamEventTypes(streamId: string): Promise<string[]> {
    const types: string[] = [];
    for await (const chunk of this.streams.read(streamId)) {
      const event = chunk.chunk;
      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof event.type === "string"
      ) {
        types.push(event.type);
      }
    }
    return types;
  }
}

/** The harness snapshot minus its journal. */
export type TestSnapshot = Omit<HarnessSnapshot, "journal">;

/** A fallible operation's outcome, so tests can assert on rejections. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly phase?: string };

function failure(error: unknown): Outcome<never> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof HarnessBuildError ? { phase: error.phase } : {})
  };
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
