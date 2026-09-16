/**
 * The Claude Code engine: one long-lived `query()` in streaming-input mode,
 * driven by inbox rows and projected into harness frames.
 *
 * Why one query for the session's life: `interrupt()`, `setModel()` and the
 * rest of the steering surface are streaming-input only, so a query per turn
 * would give up everything that makes a harness a harness. The prompt
 * iterable is fed by `prompt()`, one `SDKUserMessage` per turn, and the
 * `result` message is the turn-complete signal that settles the operation.
 *
 * Why permissions park rather than block: `canUseTool` opens a durable
 * request through the daemon and awaits it. No promise crosses the wire, so
 * an eviction in the middle of a permission costs latency and nothing else;
 * the human answers into the inbox and the reply row resolves the park.
 *
 * Credentials: `ANTHROPIC_API_KEY` is read from the environment the runtime
 * launched the container with. The key is therefore inside the sandbox that
 * runs the model's tools; see the README for what that means and for the
 * gateway-based alternative.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  type CanUseTool,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import type {
  HarnessCapability,
  HarnessInput,
  HarnessSettlement,
  JsonValue
} from "../../../../shared/src/types.ts";
import type { HarnessWireControl } from "../../../../shared/src/protocol.ts";
import type {
  ClaudeCodeOptions,
  ClaudeCodeProtocol
} from "../../../src/claude-code-types.ts";
import type { Engine, EngineConfigure, EngineContext } from "../engine.ts";
import { inputText } from "../engine.ts";
import {
  projectSdkMessage,
  type ProjectionContext,
  type SdkMessageLike
} from "./claude-code-project.ts";
import { HarnessSessionStore, type MirrorEntry } from "./session-mirror.ts";

/** Pinned forever: the SDK derives its session key from the working directory. */
const WORKSPACE = "/workspace";
/** How long a setup command may take before the engine gives up on it. */
const SETUP_TIMEOUT_MS = 120_000;
/**
 * How long the first turn waits for the Durable Object to replay the
 * transcript. The runtime configures before it delivers, so this only ever
 * fires when the restore is lost; a fresh conversation beats a wedged one.
 */
const RESTORE_GRACE_MS = 5_000;
/** How long the SDK may spend asking the mirror for a transcript. */
const LOAD_TIMEOUT_MS = 30_000;

type Turn = {
  readonly operationId: string;
  readonly text: string;
  readonly delivery: "queue" | "steer";
};

type Active = {
  readonly operationId: string;
  /** Operations folded into this turn by a `steer` delivery. */
  readonly folded: string[];
  interrupted: boolean;
  stillQueued: readonly string[];
};

/** A minimal async queue: the prompt iterable the SDK consumes. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiting: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  #closed = false;

  push(item: SDKUserMessage): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting) {
      waiter({ value: undefined, done: true });
    }
    this.#waiting = [];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>(
        (resolve) => {
          this.#waiting.push(resolve);
        }
      );
      if (result.done === true) return;
      yield result.value;
    }
  }
}

export class ClaudeCodeEngine implements Engine {
  readonly id = "claude-code";
  readonly version: string;
  readonly capabilities: readonly HarnessCapability[] = [
    "requests",
    "steer",
    "compact",
    "usage"
  ];

  #options: ClaudeCodeOptions;
  #ctx: EngineContext | undefined;
  #query: Query | undefined;
  #prompts = new MessageQueue();
  #queue: Turn[] = [];
  #active: Active | null = null;
  #started = new Set<string>();
  #liveMessageId: string | null = null;
  #engineSession: { id: string; resumed: boolean } | null = null;
  #resume: string | undefined;
  /** The session the Durable Object asked for, armed once its log is whole. */
  #resumeRequest: string | undefined;
  #remainingBudgetUsd: number | undefined;
  #previews: boolean;
  #setup: Promise<void> | undefined;
  #pumping = false;
  #stopped = false;
  readonly #mirror: HarnessSessionStore;
  /** Resolves on the first `configure()`: the restore has said all it will. */
  readonly #restored: Promise<void>;
  #settleRestore: () => void = () => {};

  constructor(options: {
    readonly options: ClaudeCodeOptions;
    /**
     * The engine session id this container last reported, from the daemon's
     * own meta table. A fallback only: a `configure({ resume })` from the
     * Durable Object supersedes it, because the Durable Object holds the
     * transcript and this container may hold nothing but a stale id.
     */
    readonly resume?: string | undefined;
    readonly previews?: boolean;
  }) {
    this.#options = options.options;
    this.#resume = options.resume;
    this.#previews = options.previews ?? true;
    this.#remainingBudgetUsd = options.options.budget?.maxUsd;
    this.version = sdkVersion();
    this.#restored = new Promise<void>((resolve) => {
      this.#settleRestore = resolve;
    });
    this.#mirror = new HarnessSessionStore({
      // SAFETY: an `engine_log` frame is one of the wire's control bodies;
      // the mirror spells the shape out rather than importing it.
      emit: (operationId, frame) => {
        this.#ctx?.emit(operationId, frame as unknown as HarnessWireControl);
      },
      activeOperationId: () => this.#active?.operationId ?? null
    });
  }

  /** What `probe()` reports for this engine. */
  diagnostics(): JsonValue {
    return {
      engineSessionId: this.#engineSession?.id ?? null,
      resumed: this.#engineSession?.resumed ?? null,
      resumeRequest: this.#resumeRequest ?? null,
      resumeArmed: this.#resume ?? null,
      queryOpen: this.#query !== undefined,
      mirror: { ...this.#mirror.stats }
    };
  }

  get engineSession(): {
    readonly id: string;
    readonly resumed: boolean;
  } | null {
    return this.#engineSession;
  }

  get activeOperationId(): string | null {
    return this.#active?.operationId ?? null;
  }

  async start(ctx: EngineContext): Promise<void> {
    this.#ctx = ctx;
    // The query is started by the first turn, not here: a container that is
    // launched and never prompted should not spawn the CLI or spend a token.
  }

  async prompt(
    operationId: string,
    input: HarnessInput,
    delivery: "queue" | "steer"
  ): Promise<void> {
    this.#queue.push({ operationId, text: inputText(input), delivery });
    void this.#pump();
  }

  async compact(
    operationId: string,
    options: { readonly instructions?: string }
  ): Promise<void> {
    // Compaction is a slash command in streaming-input mode, so it rides the
    // ordinary turn path and settles like any other operation.
    const instructions = options.instructions ?? "";
    this.#queue.push({
      operationId,
      text: instructions === "" ? "/compact" : `/compact ${instructions}`,
      delivery: "queue"
    });
    void this.#pump();
  }

  async submit(
    kind: string,
    payload: unknown,
    operationId: string | null
  ): Promise<void> {
    if (kind !== "context") throw new Error(`Unknown submission ${kind}`);
    const text = (payload as { readonly text?: string } | null)?.text ?? "";
    const ctx = this.#ctx;
    if (operationId === null || ctx === undefined) return;
    // `shouldQuery: false` appends to the transcript without starting a
    // turn; the next prompt absorbs it as context.
    await this.#ensureQuery();
    this.#prompts.push(userMessage(text, false));
    ctx.emit(operationId, { type: "begin", operationId, delivery: "queue" });
    ctx.emit(operationId, {
      type: "settle",
      operationId,
      settlement: {
        status: "completed",
        stopReason: { type: "end_turn" },
        raw: { subtype: "context" }
      }
    });
  }

  async interrupt(operationId: string): Promise<void> {
    const active = this.#active;
    if (active === null) {
      // Nothing is running: withdraw it from our own queue instead.
      this.#queue = this.#queue.filter(
        (turn) => turn.operationId !== operationId
      );
      return;
    }
    if (operationId !== "" && operationId !== active.operationId) return;
    active.interrupted = true;
    try {
      const response = await this.#query?.interrupt();
      active.stillQueued = response?.still_queued ?? [];
    } catch (error) {
      this.#ctx?.log("interrupt failed", error);
    }
  }

  async configure(patch: EngineConfigure): Promise<void> {
    if (patch.remainingBudgetUsd !== undefined) {
      this.#remainingBudgetUsd = patch.remainingBudgetUsd ?? undefined;
    }
    if (patch.engineOptions !== undefined) {
      this.#options = {
        ...this.#options,
        ...(patch.engineOptions as ClaudeCodeOptions)
      };
      await this.#query?.setModel(this.#options.model);
    }
    for (const chunk of patch.engineLog ?? []) {
      this.#mirror.restore({
        engineSessionId: chunk.engineSessionId,
        subpath: chunk.subpath,
        // SAFETY: the entries are the ones this engine's mirror emitted;
        // the Durable Object stores them opaquely and hands them back.
        entries: chunk.entries as unknown as readonly MirrorEntry[],
        chunk: chunk.chunk,
        chunks: chunk.chunks
      });
    }
    if (patch.resume !== undefined) {
      // The Durable Object is authoritative about which session continues,
      // so its id displaces the local fallback the moment it is named.
      this.#resumeRequest = patch.resume.engineSessionId;
      this.#resume = undefined;
    }
    const request = this.#resumeRequest;
    // Armed only once the whole main transcript is here: resuming an id we
    // cannot materialise asks the CLI for a conversation no container has.
    if (request !== undefined && this.#mirror.isComplete(request)) {
      this.#resume = request;
    }
    this.#settleRestore();
  }

  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.#prompts.close();
    try {
      await this.#query?.return?.(undefined);
    } catch {
      // The query is already gone.
    }
    this.#query = undefined;
  }

  /** Start the next queued turn when nothing is running. */
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const next = this.#queue[0];
        if (next === undefined || this.#stopped) return;
        const active = this.#active;
        if (active !== null) {
          if (next.delivery !== "steer") return;
          // Claude Code folds a steered message into the running turn, so
          // the operation it belongs to settles with that turn.
          this.#queue.shift();
          this.#begin(next);
          active.folded.push(next.operationId);
          this.#prompts.push(userMessage(next.text, true));
          continue;
        }
        this.#queue.shift();
        await this.#ensureQuery();
        this.#begin(next);
        this.#active = {
          operationId: next.operationId,
          folded: [],
          interrupted: false,
          stillQueued: []
        };
        this.#prompts.push(userMessage(next.text, true));
        return;
      }
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#pumping = false;
    }
  }

  #begin(turn: Turn): void {
    this.#ctx?.emit(turn.operationId, {
      type: "begin",
      operationId: turn.operationId,
      delivery: turn.delivery
    });
  }

  /**
   * Hold the first turn until the transcript restore has landed. The query
   * reads `resume` and the mirror exactly once, when it opens, so opening
   * early would silently start a fresh conversation. Bounded, because a
   * runtime that never configures must not wedge the session for ever.
   */
  async #awaitRestore(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#restored,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.#ctx?.log("no transcript restore arrived; starting fresh");
          resolve();
        }, RESTORE_GRACE_MS);
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
  }

  /** Run the setup command once, then open the long-lived query. */
  async #ensureQuery(): Promise<void> {
    if (this.#query !== undefined) return;
    await this.#awaitRestore();
    this.#setup ??= this.#runSetup();
    await this.#setup;
    const running = query({
      prompt: this.#prompts,
      options: this.#sdkOptions()
    });
    this.#query = running;
    void this.#consume(running);
  }

  #sdkOptions(): Options {
    const options = this.#options;
    return {
      cwd: WORKSPACE,
      model: options.model,
      // Never `dontAsk` or `bypassPermissions`: an ask policy needs a mode
      // that can ask, and a sandbox that skips the prompt is not a harness.
      permissionMode: options.permissionMode ?? "default",
      includePartialMessages: this.#previews,
      // The transcript mirror. `persistSession: false` and file
      // checkpointing are deliberately never set: the SDK refuses both
      // beside a store, because the mirror is fed by the local write.
      //
      // The SDK keys the store by a project key derived from `cwd`, which
      // is pinned above, so the key is the same in every container. The
      // `CLAUDE_CODE_PROJECT_DIR_NAME` override is not used: it is read
      // only when `CLAUDE_CONFIG_DIR` is also set (verified in the
      // installed SDK bundle), and pointing the config directory at a temp
      // path would cost us the container's credentials for no gain. The
      // mirror ignores the project key anyway: a container serves one
      // session, so a session id and a subpath address every transcript.
      sessionStore: this.#mirror,
      sessionStoreFlush: "batched",
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      canUseTool: this.#canUseTool(),
      hooks: { PreToolUse: [{ hooks: [this.#gate()] }] },
      // `Options.env` replaces the environment rather than extending it.
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" } as Record<
        string,
        string
      >,
      ...(options.allowedTools === undefined
        ? {}
        : { allowedTools: [...options.allowedTools] }),
      ...(options.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...options.disallowedTools] }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(this.#remainingBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: this.#remainingBudgetUsd }),
      ...(this.#resume === undefined ? {} : { resume: this.#resume }),
      ...(options.tools === undefined
        ? {}
        : { mcpServers: { host: this.#hostServer(options.tools) } })
    };
  }

  /** Drain the query, projecting every message into frames. */
  async #consume(running: Query): Promise<void> {
    try {
      for await (const message of running) {
        this.#project(message);
      }
    } catch (error) {
      if (!this.#stopped) this.#fail(error);
    }
  }

  #project(message: SDKMessage): void {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    const active = this.#active;
    const context: ProjectionContext = {
      operationId: active?.operationId ?? null,
      interrupted: active?.interrupted ?? false,
      stillQueued: active?.stillQueued ?? [],
      started: this.#started,
      liveMessageId: this.#liveMessageId
    };
    // SAFETY: `SdkMessageLike` is the subset of `SDKMessage` the projection
    // reads; the cast only forgets fields.
    const { frames, patch } = projectSdkMessage(
      message as unknown as SdkMessageLike,
      context
    );
    const operationId = context.operationId;
    for (const frame of frames) {
      if (frame.kind === "preview") ctx.preview(operationId, frame.body);
      else ctx.emit(operationId, frame.body);
    }
    if (patch.started !== undefined) this.#started.add(patch.started);
    if (patch.liveMessageId !== undefined) {
      this.#liveMessageId = patch.liveMessageId;
    }
    if (
      patch.engineSessionId !== undefined &&
      patch.engineSessionId !== this.#engineSession?.id
    ) {
      const resumed = this.#resume === patch.engineSessionId;
      this.#engineSession = { id: patch.engineSessionId, resumed };
      this.#resume = patch.engineSessionId;
      // The session id belongs to the session, not to the turn that
      // happened to reveal it, so it rides a frame of its own. The Durable
      // Object records it durably and names it back to the next container
      // as the resume target. Emitted once per id: an init that repeats the
      // session we are already in says nothing new.
      ctx.emit(null, {
        type: "engine_session",
        engineSessionId: patch.engineSessionId,
        resumed
      });
    }
    if (patch.settled === true && active !== null) {
      // The projection settled the turn; the folded operations settle with
      // it, because Claude Code answered them in the same turn.
      for (const folded of active.folded) {
        ctx.emit(folded, {
          type: "settle",
          operationId: folded,
          settlement: {
            status: "completed",
            stopReason: { type: "end_turn" },
            raw: { subtype: "folded" }
          }
        });
      }
      this.#active = null;
      void this.#pump();
    }
  }

  /** A permission request the human answers, or a host tool the Worker runs. */
  #canUseTool(): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const ctx = this.#ctx;
      const operationId = this.#active?.operationId;
      if (ctx === undefined || operationId === undefined) {
        return { behavior: "deny", message: "No operation is running" };
      }
      const reply = await ctx.openRequest({
        requestId: options.toolUseID || options.requestId || randomId(),
        operationId,
        type: "permission",
        toolCallId: options.toolUseID,
        action: toolName,
        resources: resourcesOf(input),
        input: input as JsonValue
      });
      if (reply.type !== "permission" || reply.decision === "deny") {
        const message =
          reply.type === "permission"
            ? (reply.message ?? "Denied by the operator")
            : "Denied by the operator";
        return { behavior: "deny", message };
      }
      return {
        behavior: "allow",
        updatedInput:
          (reply.input as Record<string, unknown> | undefined) ?? input
      };
    };
  }

  /**
   * The `PreToolUse` gate decides *whether* to ask; `canUseTool` does the
   * asking. The hook sees every call including auto-approved ones, which is
   * what makes an `ask` list enforceable.
   */
  #gate() {
    return async (input: unknown): Promise<HookJSONOutput> => {
      const toolName =
        (input as { readonly tool_name?: string }).tool_name ?? "";
      if ((this.#options.ask ?? []).includes(toolName)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "This tool is on the harness ask list"
          }
        };
      }
      return { continue: true };
    };
  }

  /** Host tools: every call parks as a `tool` request the Durable Object runs. */
  #hostServer(tools: NonNullable<ClaudeCodeOptions["tools"]>) {
    const definitions = Object.entries(tools).map(
      ([name, tool]): SdkMcpToolDefinition => ({
        name,
        description: tool.description,
        inputSchema: zodShapeOf(tool.inputSchema),
        handler: async (args: unknown) => {
          const ctx = this.#ctx;
          const operationId = this.#active?.operationId;
          if (ctx === undefined || operationId === undefined) {
            return {
              content: [
                { type: "text" as const, text: "No operation is running" }
              ],
              isError: true
            };
          }
          const reply = await ctx.openRequest({
            requestId: randomId(),
            operationId,
            type: "tool",
            toolCallId: randomId(),
            toolName: name,
            input: args as JsonValue
          });
          const output = reply.type === "tool" ? reply.output : null;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            ...(reply.type === "tool" && reply.isError === true
              ? { isError: true }
              : {})
          };
        }
      })
    );
    return createSdkMcpServer({ name: "host", tools: definitions });
  }

  /** Run the configured setup command once in the workspace. */
  async #runSetup(): Promise<void> {
    const setup = this.#options.setup;
    if (setup === undefined || setup.length === 0) return;
    const [command, ...args] = setup;
    if (command === undefined) return;
    await new Promise<void>((resolve) => {
      const child = spawn(command, args, { cwd: WORKSPACE, stdio: "inherit" });
      const timer = setTimeout(() => child.kill("SIGKILL"), SETUP_TIMEOUT_MS);
      const finish = (reason: unknown) => {
        clearTimeout(timer);
        if (reason !== undefined) this.#ctx?.log("setup failed", reason);
        resolve();
      };
      child.on("error", finish);
      // Setup is best effort: a failed clone must not wedge the session.
      child.on("exit", (code) =>
        finish(code === 0 ? undefined : `exit ${code}`)
      );
    });
  }

  /** Settle the running turn as failed. Used when the query itself breaks. */
  #fail(error: unknown): void {
    const ctx = this.#ctx;
    const active = this.#active;
    const message = error instanceof Error ? error.message : String(error);
    ctx?.log("claude-code engine failed", error);
    if (ctx === undefined || active === null) return;
    const settlement: HarnessSettlement<ClaudeCodeProtocol> = {
      status: "failed",
      stopReason: { type: "error" },
      error: { code: "E_ENGINE_LOST", message },
      raw: { subtype: "engine_error", is_error: true }
    };
    ctx.emit(active.operationId, {
      type: "settle",
      operationId: active.operationId,
      settlement
    });
    this.#active = null;
    this.#query = undefined;
  }
}

function userMessage(text: string, shouldQuery: boolean): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: randomId() as SDKUserMessage["uuid"],
    ...(shouldQuery ? {} : { shouldQuery: false })
  };
}

function randomId(): string {
  return crypto.randomUUID();
}

/** The paths, commands and URLs a permission prompt should name. */
function resourcesOf(input: Record<string, unknown>): readonly string[] {
  const resources: string[] = [];
  for (const key of ["file_path", "path", "command", "url", "pattern"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") resources.push(value);
  }
  return resources;
}

/**
 * The SDK registers MCP tools from a Zod raw shape, while a host tool
 * arrives as JSON Schema over the wire. This converts the top level of one
 * into the other; anything it does not recognise stays unconstrained, which
 * is safe because the answer is executed by the Durable Object, not here.
 */
function zodShapeOf(schema: JsonValue): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  if (properties === undefined) return shape;
  const rawRequired = root?.required;
  const required = Array.isArray(rawRequired) ? rawRequired : [];
  for (const [name, property] of Object.entries(properties)) {
    const description = asRecord(property)?.description;
    let field = zodFieldOf(property);
    if (typeof description === "string") field = field.describe(description);
    shape[name] = required.includes(name) ? field : field.optional();
  }
  return shape;
}

function zodFieldOf(property: JsonValue | undefined): z.ZodTypeAny {
  switch (asRecord(property)?.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/** A JSON object, or undefined for anything else. */
function asRecord(
  value: JsonValue | undefined
): { readonly [key: string]: JsonValue | undefined } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  // `Array.isArray` does not narrow a readonly array out of the union.
  return value as { readonly [key: string]: JsonValue | undefined };
}

/** The installed SDK version. It is the Claude Code version the image pins. */
function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("@anthropic-ai/claude-agent-sdk/package.json") as {
      readonly version?: string;
    };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
