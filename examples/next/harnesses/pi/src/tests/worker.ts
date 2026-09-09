import { Workspace } from "@cloudflare/shell";
import {
  BACKGROUND_CONTEXT,
  type AgentMessage
} from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { Type } from "typebox";
import { createWorkspaceExecutionEnv } from "../harness/env";
import { PiHarness } from "../harness/pi-harness";
import type {
  PiCustomEntry,
  PiEvent,
  PiExtensionApi,
  PiMessage,
  PiSlashCommand,
  PiSubmissionReceipt,
  PiTool
} from "../harness/types";
import { createModels } from "../providers/models";

const multiplyParameters = Type.Object({ value: Type.Number() });
const TOOL_REVISION_KEY = "test:pi:revision";

type ToolContext = {
  readonly revision: number;
};

/** The last tool result in a projected transcript, as text and error flag. */
function toolResult(messages: readonly PiMessage[]): {
  readonly output: string;
  readonly error: boolean;
} {
  const part = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool-result")
    .at(-1);
  if (part?.type !== "tool-result") return { output: "", error: false };
  return {
    output: part.content
      .map((content) => (content.type === "text" ? content.text : ""))
      .join(""),
    error: part.error
  };
}

function messageText(message: PiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Real Durable Object fixture using pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new PiHarness<ToolContext>({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    tasks: this.tasks,
    streams: this.streams,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    toolContext: async () => ({
      revision: (await this.ctx.storage.get<number>(TOOL_REVISION_KEY)) ?? 1
    }),
    tools: () => [this.#multiplyTool()],
    systemPrompt: "Use the supplied test tool."
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /** Run one pi-ai faux-provider turn containing a tool call. */
  async runMultiply(
    value: number,
    revision: number
  ): Promise<{
    readonly operationId: string;
    readonly status: string;
    readonly messages: readonly string[];
    readonly result: number | null;
  }> {
    await this.ctx.storage.put(TOOL_REVISION_KEY, revision);
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { value }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("tool complete")
    ]);
    const response = await this.harness.prompt(`multiply ${value}`);
    const resultPart = response.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .at(-1);
    const result =
      resultPart?.type === "tool-result" &&
      typeof resultPart.details === "object" &&
      resultPart.details !== null &&
      "result" in resultPart.details &&
      typeof resultPart.details.result === "number"
        ? resultPart.details.result
        : null;
    return {
      operationId: response.operationId,
      status: response.status,
      messages: response.messages.map(messageText),
      result
    };
  }

  /** Read the durable transcript without starting another model turn. */
  async messages(): Promise<readonly string[]> {
    return (await this.harness.getMessages()).map(messageText);
  }

  /** Read projected event type names from one operation's durable stream. */
  async eventTypes(operationId: string): Promise<readonly string[]> {
    const events: PiEvent[] = [];
    for await (const chunk of this.streams.read(
      this.harness.streamId(operationId)
    )) {
      events.push(...(chunk.chunk as unknown as PiEvent[]));
    }
    return events.map((event) => event.type);
  }

  #multiplyTool(): PiTool<
    ToolContext,
    typeof multiplyParameters,
    { readonly result: number; readonly revision: number }
  > {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply by the current tool revision.",
      parameters: multiplyParameters,
      replay: "safe",
      async execute(_id, input, _onUpdate, context) {
        const result = input.value * context.revision;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result, revision: context.revision }
        };
      }
    };
  }
}

/** Durable Object exercising pi's ExecutionEnv over a durable Workspace. */
export class PiExecutionEnvTestObject extends DurableObject<Env> {
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "pi"
  });
  readonly executionEnv = createWorkspaceExecutionEnv({
    workspace: this.workspace
  });

  /** Exercise the filesystem half and report plain JSON. */
  async fileRoundTrip(): Promise<{
    readonly write: boolean;
    readonly text: string | null;
    readonly lines: readonly string[] | null;
    readonly listed: readonly string[] | null;
    readonly info: {
      readonly name: string;
      readonly kind: string;
      readonly size: number;
    } | null;
    readonly existsBefore: boolean | null;
    readonly existsAfter: boolean | null;
    readonly missingCode: string | null;
  }> {
    const context = BACKGROUND_CONTEXT;
    const write = await this.executionEnv.writeFile(
      "/notes/todo.txt",
      "first\nsecond\n",
      context
    );
    const text = await this.executionEnv.readTextFile(
      "/notes/todo.txt",
      context
    );
    const lines = await this.executionEnv.readTextLines(
      "/notes/todo.txt",
      { maxLines: 1 },
      context
    );
    const listed = await this.executionEnv.listDir("/notes", context);
    const info = await this.executionEnv.fileInfo("/notes/todo.txt", context);
    const existsBefore = await this.executionEnv.exists(
      "/notes/todo.txt",
      context
    );
    const removed = await this.executionEnv.remove(
      "/notes/todo.txt",
      undefined,
      context
    );
    const existsAfter = await this.executionEnv.exists(
      "/notes/todo.txt",
      context
    );
    const missing = await this.executionEnv.readTextFile(
      "/notes/todo.txt",
      context
    );

    return {
      write: write.ok && removed.ok,
      text: text.ok ? text.value : null,
      lines: lines.ok ? lines.value : null,
      listed: listed.ok ? listed.value.map((entry) => entry.path) : null,
      info: info.ok
        ? {
            name: info.value.name,
            kind: info.value.kind,
            size: info.value.size
          }
        : null,
      existsBefore: existsBefore.ok ? existsBefore.value : null,
      existsAfter: existsAfter.ok ? existsAfter.value : null,
      missingCode: missing.ok ? null : missing.error.code
    };
  }

  /** Run one shell command and report what it left in the workspace. */
  async runShell(
    command: string,
    timeout?: number
  ): Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly errorCode: string | null;
    readonly streamed: readonly string[];
  }> {
    const streamed: string[] = [];
    const result = await this.executionEnv.exec(
      command,
      {
        ...(timeout === undefined ? {} : { timeout }),
        onStdout: (chunk) => streamed.push(chunk)
      },
      BACKGROUND_CONTEXT
    );
    return {
      ok: result.ok,
      stdout: result.ok ? result.value.stdout : "",
      stderr: result.ok ? result.value.stderr : "",
      exitCode: result.ok ? result.value.exitCode : null,
      errorCode: result.ok ? null : result.error.code,
      streamed
    };
  }

  /** Read one workspace file directly, bypassing the execution environment. */
  async readWorkspaceFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }
}

/** Durable Object wiring pi's own execution tools onto a Workspace. */
export class PiBuiltinToolsTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "pi"
  });
  readonly harness = new PiHarness({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    tasks: this.tasks,
    streams: this.streams,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    executionEnv: createWorkspaceExecutionEnv({ workspace: this.workspace }),
    builtinTools: ["read", "write", "edit", "bash"],
    systemPrompt: "Use the workspace."
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /**
   * Drive two faux turns: pi's own `bash` tool writes a workspace file, then
   * pi's own `read` tool reads it back through the same execution environment.
   */
  async runBuiltinTools(): Promise<{
    readonly writeStatus: string;
    readonly readStatus: string;
    readonly file: string | null;
    readonly readOutput: string;
  }> {
    this.#faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "echo hi > /a.txt" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("wrote it")
    ]);
    const write = await this.harness.prompt("write a file");
    const file = await this.workspace.readFile("/a.txt");

    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "/a.txt" }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("read it")
    ]);
    const read = await this.harness.prompt("read the file");
    const readOutput = read.messages
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.type === "tool-result" && part.name === "read" ? part.content : []
      )
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("");

    return {
      writeStatus: write.status,
      readStatus: read.status,
      file,
      readOutput
    };
  }
}

const echoParameters = Type.Object({ text: Type.String() });

/** Durable Object exercising the pi extension surface. */
export class PiExtensionsTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly #contextSeen: string[] = [];
  #throwOnMessageEnd = false;
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new PiHarness({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    tasks: this.tasks,
    streams: this.streams,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    tools: () => [this.#multiplyTool()],
    extensions: [{ name: "test", factory: (pi) => this.#register(pi) }],
    flags: { "note-prefix": "flagged" },
    promptTemplates: [
      {
        name: "greet",
        description: "Greet somebody by name.",
        content: "Say hello to $1"
      }
    ],
    resources: {
      skills: [
        {
          name: "tidy",
          description: "Tidy the workspace.",
          content: "Tidy everything you can find.",
          filePath: "/skills/tidy.md"
        }
      ]
    },
    uiRequestTimeoutMs: 5_000,
    systemPrompt: "Use the supplied test tools.",
    configure: (hooks) => {
      // Registered after the extension runtime's own hooks, so this observes
      // the messages an extension `context` handler produced.
      hooks.on("transform_context", (event) => {
        const { messages } = event as { messages: readonly AgentMessage[] };
        for (const message of messages) {
          if (message.role !== "user") continue;
          this.#contextSeen.push(
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join("")
          );
        }
        return undefined;
      });
    }
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);

  /** Run one faux turn whose tool call goes to the extension's own tool. */
  async runEcho(text: string): Promise<{
    readonly operationId: string;
    readonly status: string;
    readonly output: string;
    readonly toolError: boolean;
  }> {
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("echoed")
    ]);
    const response = await this.harness.prompt(`echo ${text}`);
    const result = toolResult(response.messages);
    return {
      operationId: response.operationId,
      status: response.status,
      output: result.output,
      toolError: result.error
    };
  }

  /** Run one faux turn calling the harness tool the extension may block. */
  async runMultiply(value: number): Promise<{
    readonly operationId: string;
    readonly status: string;
    readonly output: string;
    readonly toolError: boolean;
  }> {
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { value }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("multiplied")
    ]);
    const response = await this.harness.prompt(`multiply ${value}`);
    const result = toolResult(response.messages);
    return {
      operationId: response.operationId,
      status: response.status,
      output: result.output,
      toolError: result.error
    };
  }

  /** Make the extension's `message_end` handler throw on the next run. */
  async failMessageEnd(fail: boolean): Promise<void> {
    this.#throwOnMessageEnd = fail;
  }

  /** User-role text every provider request carried, across runs. */
  async contextSeen(): Promise<readonly string[]> {
    return [...this.#contextSeen];
  }

  /** The durable transcript, as text. */
  async messages(): Promise<readonly string[]> {
    return (await this.harness.getMessages()).map(messageText);
  }

  /**
   * Submit one line of text the way a client would, slash commands included,
   * and wait for whatever it produced.
   */
  async submitText(text: string): Promise<{
    readonly accepted: boolean;
    readonly command: string | null;
    readonly status: string | null;
  }> {
    this.#faux.setResponses([fauxAssistantMessage("done")]);
    const receipt: PiSubmissionReceipt = await this.harness.submit({
      kind: "prompt",
      prompt: text
    });
    if (!receipt.accepted) {
      return {
        accepted: false,
        command: receipt.command ?? null,
        status: null
      };
    }
    const result = await this.harness.waitForResult(receipt.operationId);
    return { accepted: true, command: null, status: result.status };
  }

  /** Slash commands this session offers, as a client's autocomplete sees them. */
  async commands(): Promise<readonly PiSlashCommand[]> {
    return this.harness.getCommands();
  }

  /** Set one extension flag and report every flag afterwards. */
  async setFlag(
    name: string,
    value: boolean | string
  ): Promise<Record<string, boolean | string>> {
    return this.harness.setFlag(name, value);
  }

  /**
   * Custom entries extensions appended to the transcript, flattened: the
   * recursive JSON payload type crosses the RPC boundary poorly.
   */
  async customEntries(): Promise<
    readonly { readonly customType: string; readonly text: string | null }[]
  > {
    const entries: readonly PiCustomEntry[] =
      await this.harness.getCustomEntries();
    return entries.map((entry) => {
      const data = entry.data;
      const text =
        typeof data === "object" &&
        data !== null &&
        !Array.isArray(data) &&
        typeof data.text === "string"
          ? data.text
          : null;
      return { customType: entry.customType, text };
    });
  }

  /** Names of every tool currently offered to the model. */
  async toolNames(): Promise<readonly string[]> {
    return (await this.harness.snapshot()).tools.map((tool) => tool.name);
  }

  /**
   * One operation's durable events, flattened to the fields the tests read.
   * The full union crosses the RPC boundary poorly.
   */
  async events(operationId: string): Promise<
    readonly {
      readonly type: string;
      readonly error?: boolean;
      readonly message?: string;
    }[]
  > {
    const events: PiEvent[] = [];
    for await (const chunk of this.streams.read(
      this.harness.streamId(operationId)
    )) {
      events.push(...(chunk.chunk as unknown as PiEvent[]));
    }
    return events.map((event) => ({
      type: event.type,
      ...("error" in event && typeof event.error === "boolean"
        ? { error: event.error }
        : {}),
      ...("message" in event && typeof event.message === "string"
        ? { message: event.message }
        : {})
    }));
  }

  #register(pi: PiExtensionApi): void {
    pi.registerFlag("note-prefix", {
      type: "string",
      default: "note",
      description: "Prefix for appended notes."
    });
    pi.registerTool({
      name: "echo",
      label: "Echo",
      description: "Echo the supplied text back.",
      parameters: echoParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // "pick ..." asks the client to choose, which is the blocking
        // extension UI surface running inside a tool call.
        if (!params.text.startsWith("pick")) {
          return {
            content: [{ type: "text", text: `echo:${params.text}` }],
            details: { text: params.text }
          };
        }
        const choice = await ctx.ui.select("Pick one", ["a", "b"]);
        return {
          content: [{ type: "text", text: `echo:${params.text}:${choice}` }],
          details: { text: params.text }
        };
      }
    });
    pi.on("tool_call", (event) => {
      const value = (event.input as { value?: unknown }).value;
      if (event.toolName === "multiply" && value === 13) {
        return { block: true, reason: "unlucky number" };
      }
      return undefined;
    });
    pi.on("context", (event) => ({
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: `${String(pi.getFlag("note-prefix"))}: extension note`,
          timestamp: Date.now()
        }
      ]
    }));
    pi.on("message_end", () => {
      if (this.#throwOnMessageEnd)
        throw new Error("message_end handler failed");
    });
    pi.registerCommand("note", {
      description: "Append a note to the transcript.",
      handler: async (args) => {
        pi.appendEntry("test:note", { text: args });
      }
    });
  }

  #multiplyTool(): PiTool<
    object | undefined,
    typeof multiplyParameters,
    { readonly result: number }
  > {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply by two.",
      parameters: multiplyParameters,
      async execute(_id, input) {
        const result = input.value * 2;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result }
        };
      }
    };
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
