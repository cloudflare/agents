import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult
} from "@ai-sdk/provider";
import { Harness } from "@cloudflare/agents-next-harness";
import type {
  HarnessReceipt,
  HarnessResult
} from "@cloudflare/agents-next-harness";
import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import type { JsonObject, JsonValue } from "../json";
import { toJsonValue } from "../json";
import type {
  HarnessRevision,
  SelfModifyingProtocol,
  SelfModifyingSnapshot
} from "../protocol";
import type {
  HarnessInferenceResult,
  HarnessMessage,
  HarnessModelRequest,
  HarnessToolCall,
  HarnessToolDefinition
} from "../runtime-types";
import { SelfModifyingRuntime } from "../self-modifying-runtime";

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

/** The snapshot minus its journal, which recursive JSON makes unRPC-able. */
export type TestSnapshot = Omit<SelfModifyingSnapshot, "journal">;

/** What one settled prompt turn looks like to a test. */
export type TurnReport = {
  readonly status: HarnessResult["status"];
  readonly output: string | null;
  readonly error: string | null;
  readonly code: string | null;
  readonly revisionId: number | null;
  readonly rounds: number | null;
  readonly isolateRun: number | null;
};

/** A source operation's outcome, so tests can assert on rejections. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly phase: string };

function outcome<T>(
  result: HarnessResult<SelfModifyingProtocol>,
  read: (raw: SelfModifyingProtocol["result"]) => T
): Outcome<T> {
  if (result.status === "completed" && result.raw !== undefined) {
    return { ok: true, value: read(result.raw) };
  }
  return {
    ok: false,
    error: result.error?.message ?? result.stopReason.type,
    phase: result.error?.code ?? "unknown"
  };
}

function revisionOf(raw: SelfModifyingProtocol["result"]): HarnessRevision {
  if (!("revision" in raw)) throw new Error("Expected a revision result");
  return raw.revision;
}

/** Test-only Durable Object with a deterministic LanguageModelV4. */
export class TestSelfModifyingHarnessObject extends DurableObject<Env> {
  private readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "self_modifying"
  });
  private readonly tasks = new Tasks();
  private readonly streams = new Streams();
  private readonly runtime = new SelfModifyingRuntime({
    workspace: this.workspace,
    loader: this.env.LOADER,
    model: new TestLanguageModel()
  });
  private readonly harness = new Harness<SelfModifyingProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.runtime
  });
  private readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /** The active revision, its source, and the revision list. */
  async snapshot(): Promise<TestSnapshot> {
    await this.lifecycle.start();
    const { journal: _journal, ...rest } = this.runtime.snapshot();
    return rest;
  }

  /** Admit a prompt and return its receipt without waiting for the turn. */
  async admit(prompt: string, operationId?: string): Promise<HarnessReceipt> {
    await this.lifecycle.start();
    return this.harness
      .session()
      .prompt(prompt, operationId === undefined ? {} : { operationId });
  }

  /** Admit a prompt and wait for its settled turn. */
  async prompt(prompt: string): Promise<TurnReport> {
    const receipt = await this.admit(prompt);
    await this.#wait(receipt.operationId);
    return this.report(receipt.operationId);
  }

  /** The settled state of one turn, or its queued status while it runs. */
  async report(operationId: string): Promise<TurnReport> {
    await this.lifecycle.start();
    const result = await this.harness.session().result(operationId);
    const operation = this.runtime.operation(operationId);
    const raw = result?.raw;
    return {
      status: result?.status ?? "declined",
      output: raw && "output" in raw ? (raw.output ?? null) : null,
      error: result?.error?.message ?? null,
      code: result?.error?.code ?? null,
      revisionId: operation?.revisionId ?? null,
      rounds: operation?.rounds ?? null,
      isolateRun: operation?.isolateRun ?? null
    };
  }

  /** Whether one operation has settled yet, for a detached submission. */
  async settled(operationId: string): Promise<string | null> {
    await this.lifecycle.start();
    return (await this.harness.session().result(operationId))?.status ?? null;
  }

  /** Write one working source file through a durable submission. */
  async writeSource(
    path: string,
    content: string
  ): Promise<Outcome<{ readonly path: string }>> {
    const result = await this.#submit({
      kind: "write_source",
      payload: { path, content }
    });
    return outcome(result, (raw) => {
      if (!("path" in raw)) throw new Error("Expected a path result");
      return { path: raw.path };
    });
  }

  /** Build and activate the working source through a durable submission. */
  async activate(note: string): Promise<Outcome<HarnessRevision>> {
    return outcome(
      await this.#submit({ kind: "activate", payload: { note } }),
      revisionOf
    );
  }

  /** Restore an activated snapshot through a durable submission. */
  async restore(revisionId: number): Promise<Outcome<HarnessRevision>> {
    return outcome(
      await this.#submit({ kind: "restore", payload: { revisionId } }),
      revisionOf
    );
  }

  /** Every event type in the session's durable log, in seq order. */
  async eventTypes(from?: string): Promise<string[]> {
    await this.lifecycle.start();
    const types: string[] = [];
    const controller = new AbortController();
    for await (const event of this.harness.session().events({
      ...(from === undefined ? {} : { from }),
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if ("preview" in event) continue;
      const body = event.body;
      types.push(
        body.type === "extension" ? `extension:${body.body.type}` : body.type
      );
    }
    return types;
  }

  /** The transcript the shared client renders. */
  async messages(): Promise<string[]> {
    await this.lifecycle.start();
    return (await this.harness.session().messages()).messages.map((message) =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
    );
  }

  async #submit(
    submission: SelfModifyingProtocol["submit"]
  ): Promise<HarnessResult<SelfModifyingProtocol>> {
    await this.lifecycle.start();
    const receipt = await this.harness.session().submit(submission);
    return this.#wait(receipt.operationId);
  }

  #wait(operationId: string): Promise<HarnessResult<SelfModifyingProtocol>> {
    return this.harness.session().wait(operationId, { timeoutMs: 20_000 });
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
