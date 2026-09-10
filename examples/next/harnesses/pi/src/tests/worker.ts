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
import { createSyntheticSourceInfo } from "../../vendor/pi-coding-agent-src/core/source-info.ts";
import { createWorkspaceExecutionEnv } from "../harness/env";
import { PiHarness } from "../harness/pi-harness";
import type {
  PiCustomEntry,
  PiEvent,
  PiExtensionApi,
  PiMessage,
  PiResourceLoader,
  PiSlashCommand,
  PiSubmissionReceipt,
  PiTool
} from "../harness/types";
import { createModels } from "../providers/models";

const multiplyParameters = Type.Object({ value: Type.Number() });
const TOOL_REVISION_KEY = "test:pi:revision";
/** Set when a test simulates a deployment that registers an extra tool. */
const DEPLOYED_TOOL_KEY = "test:pi:deployed-tool";

type ToolContext = {
  readonly revision: number;
};

/**
 * A resource loader serving one prompt template of its own, standing in for
 * a host that keeps its resources somewhere the harness configuration does
 * not reach.
 *
 * Only the surface the harness reads is real. `getExtensions` is not part of
 * that surface — the runtime loads extensions from the configuration — so it
 * answers with an empty result rather than a fabricated runtime.
 */
function deployResourceLoader(): PiResourceLoader {
  const filePath = "<loader:deploy>";
  const prompts = [
    {
      name: "deploy",
      description: "Deploy to an environment.",
      content: "Deploy to $1",
      filePath,
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "loader" })
    }
  ];
  return {
    getExtensions: () =>
      ({ extensions: [], errors: [] }) as unknown as ReturnType<
        PiResourceLoader["getExtensions"]
      >,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [...prompts], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
}

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
  readonly #systemPromptSeen: string[] = [];
  readonly #agentEndTexts: string[][] = [];
  #throwOnMessageEnd = false;
  #inputCalls = 0;
  /** Resolved by the extension tool once it is waiting on `ctx.signal`. */
  #toolWaiting: (() => void) | undefined;
  /** Releases the extension tool that blocks until a test lets it finish. */
  #releaseTool: (() => void) | undefined;
  /** What the first `tool_result` handler of a run saw of pending messages. */
  #pendingSeen: boolean | undefined;
  /** The extension surface, captured when the extension loads. */
  #pi: PiExtensionApi | undefined;
  /** Held by the resource source to keep one tool refresh pass open. */
  #refreshGate: Promise<void> | undefined;
  /** Resolved once a refresh pass has reached {@link #refreshGate}. */
  #refreshGateEntered: (() => void) | undefined;
  /** Whether the extension tool saw its own cancellation. */
  #toolSawAbort = false;
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
    // Durable, not process-local: a test that simulates a deploy adding a
    // tool has to keep the addition across the eviction that stands in for
    // the new isolate.
    tools: async () =>
      (await this.ctx.storage.get<boolean>(DEPLOYED_TOOL_KEY)) === true
        ? [this.#multiplyTool(), this.#deployedTool()]
        : [this.#multiplyTool()],
    extensions: [{ name: "test", factory: (pi) => this.#register(pi) }],
    flags: { "note-prefix": "flagged" },
    promptTemplates: [
      {
        name: "greet",
        description: "Greet somebody by name.",
        content: "Say hello to $1"
      }
    ],
    // A function, not an object, so a test can hold one refresh pass open.
    // `#resolveResources` runs after `#resolveTools` has read the extension
    // tool registry, which is exactly the window a late registration falls
    // into.
    resources: async () => {
      const gate = this.#refreshGate;
      if (gate !== undefined) {
        this.#refreshGate = undefined;
        this.#refreshGateEntered?.();
        this.#refreshGateEntered = undefined;
        await gate;
      }
      return {
        skills: [
          {
            name: "tidy",
            description: "Tidy the workspace.",
            content: "Tidy everything you can find.",
            filePath: "/skills/tidy.md"
          }
        ]
      };
    },
    resourceLoader: deployResourceLoader(),
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
  async runEcho(
    text: string,
    lane?: string
  ): Promise<{
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
    const response = await this.harness.prompt(
      `echo ${text}`,
      lane === undefined ? {} : { lane }
    );
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

  /**
   * Submit the same prompt twice under one operation id, the way a client
   * retrying a dropped response does, and report how many times the
   * extension's `input` handler saw it.
   */
  async submitTwice(text: string): Promise<{
    readonly first: boolean;
    readonly second: boolean;
    readonly inputCalls: number;
  }> {
    this.#faux.setResponses([fauxAssistantMessage("done")]);
    this.#inputCalls = 0;
    const operationId = crypto.randomUUID();
    const first = await this.harness.submit(
      { kind: "prompt", prompt: text },
      { operationId }
    );
    const second = await this.harness.submit(
      { kind: "prompt", prompt: text },
      { operationId }
    );
    await this.harness.waitForResult(operationId);
    return {
      first: first.accepted,
      second: second.accepted,
      inputCalls: this.#inputCalls
    };
  }

  /**
   * Submit one line of text through `prompt`, which waits for whatever it
   * produced. A slash command produces no operation, so this is also the
   * regression test for waiting on one.
   */
  async promptText(text: string): Promise<{
    readonly status: string;
    readonly command: string | null;
    readonly handled: boolean;
  }> {
    this.#faux.setResponses([fauxAssistantMessage("done")]);
    const response = await this.harness.prompt(text);
    return {
      status: response.status,
      command: response.command ?? null,
      handled: response.handled ?? false
    };
  }

  /** Whatever is waiting in one lane's queue, as the snapshot projects it. */
  async queued(): Promise<
    readonly {
      readonly kind: string;
      readonly role: string | null;
      readonly text: string | null;
    }[]
  > {
    const snapshot = await this.harness.snapshot();
    return snapshot.queue.map((item) => ({
      kind: item.kind,
      role: item.message?.role ?? null,
      text: item.message === undefined ? null : messageText(item.message)
    }));
  }

  /** Make the extension's `message_end` handler throw on the next run. */
  async failMessageEnd(fail: boolean): Promise<void> {
    this.#throwOnMessageEnd = fail;
  }

  /** The system prompt every `before_agent_start` handler saw, in order. */
  async systemPromptsSeen(): Promise<readonly string[]> {
    return [...this.#systemPromptSeen];
  }

  /** The message texts every `agent_end` reported, one entry per run. */
  async agentEndTexts(): Promise<readonly (readonly string[])[]> {
    return this.#agentEndTexts.map((texts) => [...texts]);
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

  /**
   * Try to set one flag and report the failure rather than rejecting, so a
   * refusal crosses the RPC boundary as a value. `setFlag` itself throws,
   * which is what the transport turns into an `error` frame.
   */
  async setFlagError(
    name: string,
    value: boolean | string
  ): Promise<string | null> {
    try {
      await this.harness.setFlag(name, value);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Every extension flag's current value. */
  async flags(): Promise<Record<string, boolean | string>> {
    return this.harness.getFlags();
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
  async customEntries(
    lane?: string
  ): Promise<
    readonly { readonly customType: string; readonly text: string | null }[]
  > {
    const entries: readonly PiCustomEntry[] =
      await this.harness.getCustomEntries(lane === undefined ? {} : { lane });
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

  /** The lane's durable tool selection, as the snapshot reports it. */
  async activeTools(): Promise<readonly string[]> {
    return [...(await this.harness.snapshot()).activeTools].sort((a, b) =>
      a.localeCompare(b)
    );
  }

  /**
   * Run a turn whose extension tool blocks until its own cancellation, abort
   * it, and report what the tool saw.
   */
  async runAbortedTool(): Promise<{
    readonly status: string;
    readonly sawAbort: boolean;
  }> {
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "hang" }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("done")
    ]);
    this.#toolSawAbort = false;
    const waiting = new Promise<void>((resolve) => {
      this.#toolWaiting = resolve;
    });
    const run = this.harness.prompt("hang");
    await waiting;
    await this.harness.abort();
    const response = await run;
    return { status: response.status, sawAbort: this.#toolSawAbort };
  }

  /**
   * Run a turn whose extension tool blocks, submit a second prompt onto the
   * same lane while it is blocked, and report what the extension's
   * `tool_result` handler saw of `ctx.hasPendingMessages()`.
   *
   * The second prompt sits in the harness's intake table for as long as the
   * first operation holds the lane, so it is invisible in pi's own snapshot.
   */
  async pendingDuringRun(kind: "prompt" | "compaction" = "prompt"): Promise<{
    readonly pendingSeen: boolean | undefined;
    readonly pendingAfter: number;
  }> {
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "wait" }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("echoed"),
      fauxAssistantMessage("second")
    ]);
    this.#pendingSeen = undefined;
    const waiting = new Promise<void>((resolve) => {
      this.#toolWaiting = resolve;
    });
    const run = this.harness.prompt("wait");
    await waiting;
    const second = await this.harness.submit(
      kind === "prompt" ? { kind: "prompt", prompt: "second" } : { kind }
    );
    const pendingAfter = (await this.harness.pending()).length;
    this.#releaseTool?.();
    this.#releaseTool = undefined;
    await run;
    await this.harness.waitForResult(second.operationId);
    return { pendingSeen: this.#pendingSeen, pendingAfter };
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

  /**
   * Register two tools with the second landing after the refresh pass in
   * flight has already read the tool registry, and report the lane's active
   * tools once everything has settled.
   *
   * A pass that returned early on an overlapping request dropped the second
   * registration: the registry held the tool, but no `setTools` or lane
   * reconciliation ever saw it.
   */
  async overlappingToolRefresh(): Promise<readonly string[]> {
    // One real turn first: it loads the extension, captures `pi`, and leaves
    // the lane with a reconciliation baseline. Without one, the first refresh
    // pass is the lane's first ever and leaves an existing selection alone
    // by design, which is a different story from this one.
    await this.runEcho("first");
    const pi = this.#pi;
    if (pi === undefined) throw new Error("the test extension did not load");

    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      this.#refreshGateEntered = resolve;
    });
    this.#refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Starts a pass, which resolves the tools and then blocks in the
    // resource source.
    this.#registerLateTool(pi, "late-one");
    await entered;
    // Lands after that pass read the registry: only a repeat installs it.
    this.#registerLateTool(pi, "late-two");
    release();

    return this.#settledTools("late-two");
  }

  /** Poll the lane's active tools until `name` appears, or give up. */
  async #settledTools(name: string): Promise<readonly string[]> {
    let active = await this.activeTools();
    for (let attempt = 0; attempt < 200 && !active.includes(name); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      active = await this.activeTools();
    }
    return active;
  }

  /** Register a tool the harness did not have when it started running. */
  #registerLateTool(pi: PiExtensionApi, name: string): void {
    pi.registerTool({
      name,
      label: name,
      description: "Registered while a refresh was in flight.",
      parameters: multiplyParameters,
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: `${name}:${params.value}` }],
          details: { value: params.value }
        };
      }
    });
  }

  #register(pi: PiExtensionApi): void {
    this.#pi = pi;
    // Closures rather than `this`: the tool's `execute` is a shorthand
    // method, so it has a `this` of its own.
    const waiting = () => {
      this.#toolWaiting?.();
      this.#toolWaiting = undefined;
    };
    const sawAbort = () => {
      this.#toolSawAbort = true;
    };
    const blockUntilReleased = () =>
      new Promise<void>((resolve) => {
        this.#releaseTool = resolve;
        waiting();
      });
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
        // "hang" blocks on the extension surface's own `ctx.signal`, which
        // is the cancellation of the call it is running inside.
        if (params.text === "hang") {
          const signal = ctx.signal;
          if (signal === undefined) {
            return {
              content: [{ type: "text", text: "echo:hang:no-signal" }],
              details: { text: params.text }
            };
          }
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
            waiting();
          });
          sawAbort();
          return {
            content: [{ type: "text", text: "echo:hang:aborted" }],
            details: { text: params.text }
          };
        }
        // "wait" blocks until the test releases it, which holds the lane
        // open while a second prompt is submitted onto it.
        if (params.text === "wait") {
          await blockUntilReleased();
          return {
            content: [{ type: "text", text: "echo:wait" }],
            details: { text: params.text }
          };
        }
        // "mark ..." writes through the synchronous `pi.*` surface from
        // inside the tool body, which is what places the call on a lane.
        if (params.text.startsWith("mark")) {
          pi.appendEntry("test:tool-lane", { text: params.text });
          return {
            content: [{ type: "text", text: `echo:${params.text}` }],
            details: { text: params.text }
          };
        }
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
      // A gate that throws is a gate that did not decide; the harness has to
      // treat that as a refusal rather than an approval.
      if (event.toolName === "multiply" && value === 7) {
        throw new Error("tool_call handler exploded");
      }
      return undefined;
    });
    // `tool_result` runs on a freshly refreshed lane read model, so it is
    // where a run observes what is waiting behind it.
    pi.on("tool_result", (_event, ctx) => {
      if (this.#pendingSeen === undefined) {
        this.#pendingSeen = ctx.hasPendingMessages();
      }
    });
    pi.on("input", (event) => {
      this.#inputCalls += 1;
      return event.text.startsWith("swallow")
        ? { action: "handled" as const }
        : { action: "continue" as const };
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
    pi.on("before_agent_start", (event) => {
      this.#systemPromptSeen.push(event.systemPrompt);
      return undefined;
    });
    pi.on("agent_end", (event) => {
      this.#agentEndTexts.push(
        event.messages.map((message) => {
          const content = "content" in message ? message.content : "";
          if (typeof content === "string") return content;
          return content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
        })
      );
    });
    pi.registerCommand("note", {
      description: "Append a note to the transcript.",
      handler: async (args) => {
        pi.appendEntry("test:note", { text: args });
      }
    });
    pi.registerCommand("only", {
      description: "Narrow the active tool set to the named tool.",
      handler: async (args) => {
        pi.setActiveTools([args.trim()]);
      }
    });
    pi.registerCommand("announce", {
      description: "Send a custom message that the next run picks up.",
      handler: async (args) => {
        pi.sendMessage(
          {
            customType: "test:announce",
            content: args,
            display: true
          },
          { triggerTurn: true }
        );
      }
    });
  }

  /** Stand in for a deploy that registers a tool this object did not have. */
  async deployTool(): Promise<void> {
    await this.ctx.storage.put(DEPLOYED_TOOL_KEY, true);
  }

  #deployedTool(): PiTool<
    object | undefined,
    typeof multiplyParameters,
    { readonly result: number }
  > {
    return {
      name: "deployed",
      label: "Deployed",
      description: "A tool a later deployment registered.",
      parameters: multiplyParameters,
      async execute(_id, input) {
        const result = input.value;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result }
        };
      }
    };
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
