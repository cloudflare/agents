import type { SkillSource } from "../../skills";
import type {
  InferInput,
  JsonObject,
  JsonValue,
  ToolInputSchema
} from "./schema";

/**
 * The portable extension format: one shape that runs on every harness.
 *
 * An extension is a function. The harness calls it with a context, and it
 * registers things there:
 *
 * - **Transforms** over a domain (`tool`, `instructions`, `skill`,
 *   `command`). A transform edits a draft. The harness rebuilds a domain by
 *   starting from its base (empty, or the harness's native tools) and
 *   running every transform once, in order, so a rebuild always gives the
 *   same result and never stacks an edit twice. Call the domain's
 *   `reload()` when data a transform reads has changed. `ctx.tool.add(tool)`
 *   is a transform that adds one tool.
 * - **Hooks** on a running tool call (`tool.hook("execute.before")`). A hook
 *   edits the event it is handed; later hooks see earlier hooks' edits.
 * - **Event handlers** (`event.on("turn.end")`), which observe and cannot
 *   change anything.
 *
 * ```ts
 * const guard: Extension = (ctx) => {
 *   ctx.tool.add({ id: "add", description: "Add.", input, execute });
 *   ctx.tool.hook("execute.before", (event) => {
 *     if (event.tool === "shell") event.ask = "Run this command?";
 *   });
 * };
 * ```
 *
 * Registering is synchronous and returns a `Registration`; disposing it
 * removes it and rebuilds the domain. Removing an extension disposes all of
 * them. The names follow OpenCode 2's plugin API.
 */

/** A registered transform, hook or handler. */
export type Registration = {
  /** Remove the registration and rebuild its domain. Idempotent. */
  readonly dispose: () => Promise<void>;
};

/** What an extension may return: cleanup run when it is removed. */
export type Cleanup = () => void | Promise<void>;

/**
 * A portable extension: a function of its context.
 *
 * It runs every time the harness starts, which on a Durable Object means
 * after every eviction. Keep what must survive in `ctx.storage`, and give
 * tools ids that do not change between runs: a harness resumes an
 * interrupted tool call by its tool's id.
 *
 * Reports name an extension by its function name, so a named function
 * (`function guard(ctx) {}`) reads better in logs than an arrow.
 */
export type Extension = (
  context: ExtensionContext
) => void | Cleanup | Promise<void | Cleanup>;

/** A feature a harness may or may not support. */
export type ExtensionFeature =
  | "tool"
  | "tool.deferred"
  | "tool.native.remove"
  | "tool.native.update"
  | "tool.execute.before"
  | "tool.execute.after"
  | "tool.ask"
  | "instructions"
  | "skill"
  | "command"
  | "event"
  | "session.submit"
  | "session.note";

/** What an extension is handed. */
export type ExtensionContext = {
  /** The harness running the extension, such as `"pi"` or `"opencode"`. */
  readonly harness: string;
  /**
   * Whether this harness supports a feature. Using an unsupported one
   * throws `ExtensionFeatureUnsupported`, which fails the extension while it
   * starts; check first to degrade instead.
   */
  supports(feature: ExtensionFeature): boolean;
  readonly tool: ToolDomain;
  readonly instructions: InstructionsDomain;
  readonly skill: SkillDomain;
  readonly command: CommandDomain;
  readonly event: EventDomain;
  /**
   * Durable key-value storage under `namespace`, synchronous so transforms
   * can read it while they rebuild. Two extensions that pass the same
   * namespace share it.
   */
  storage(namespace: string): ExtensionStorage;
  /**
   * One session of the harness. Use it at runtime (from tools, hooks,
   * commands and handlers), not while the extension is starting: the
   * harness is not open yet.
   */
  session(id: string): ExtensionSession;
};

/** A domain whose value is rebuilt from transforms. */
export type TransformDomain<Draft> = {
  /**
   * Register a transform. While the extension is starting, every transform
   * it registers rebuilds once, after it returns; later, the domain rebuilds
   * now. Await `reload()` to wait for a rebuild.
   */
  transform(edit: (draft: Draft) => void | Promise<void>): Registration;
  /** Rebuild the domain from scratch, running every transform once. */
  reload(): Promise<void>;
};

// ── Tools ─────────────────────────────────────────────────────────────────

/** One part of a tool result. */
export type ToolContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      /** Base64. */
      readonly data: string;
      readonly mimeType: string;
    };

/** What a tool returns. */
export type ToolResult = {
  /** What the model sees. A string is one text part. */
  readonly content: string | readonly ToolContentPart[];
  /** The call failed; the model sees the content as an error. */
  readonly isError?: boolean;
  /**
   * Structured data for clients and hooks. The model never sees it.
   * pi stores it as the result's `details`, OpenCode as `metadata`.
   */
  readonly metadata?: JsonObject;
  /**
   * Deferred tools to offer this session from the next model request on.
   * This is how a loader tool (`web_enable`) turns tools on for one session.
   */
  readonly activate?: readonly string[];
};

/** A question for the person using the session. */
export type UserRequest =
  | { readonly kind: "confirm"; readonly message: string }
  | {
      readonly kind: "select";
      readonly message: string;
      readonly options: readonly string[];
    }
  | { readonly kind: "input"; readonly message: string };

/** What answers each kind of `UserRequest`. */
export type UserReply<R extends UserRequest> = R extends {
  readonly kind: "confirm";
}
  ? boolean
  : string;

/** What a tool's `execute` is handed besides its input. */
export type ToolCallContext = {
  /** The session the call belongs to, as the harness names it. */
  readonly session: string;
  /** The model's id for this call. */
  readonly callId: string;
  /** Aborts when the call is cancelled. */
  readonly signal: AbortSignal;
  /** Report progress text a client can show while the tool runs. */
  progress(text: string): void;
  /** Replace the call's live metadata, for clients that render it. */
  update(metadata: JsonObject): Promise<void>;
  /**
   * Ask the person using the session and wait for the answer.
   *
   * The question is stored, and the harness lists it in `requests()` until
   * someone calls `reply()`. If the object is evicted while waiting,
   * `execute` runs again from the top after it restarts, and this `ask`
   * returns the stored answer instead of asking twice. So a tool that asks
   * must be `replay: "safe"`, and anything it does before an `ask` must be
   * safe to repeat. Asking from a tool without `replay: "safe"` throws.
   */
  ask<R extends UserRequest>(request: R): Promise<UserReply<R>>;
};

/**
 * What happens to a call the object was evicted during.
 *
 * - `unsafe` (default): report the call as interrupted; do not run it again.
 * - `safe`: run it again. For reads, idempotent writes, and tools that ask.
 */
export type ToolReplay = "safe" | "unsafe";

/**
 * A portable tool.
 *
 * @template S - The input schema.
 */
export type Tool<
  S extends ToolInputSchema<unknown> = ToolInputSchema<unknown>
> = {
  /** The name the model calls it by. Stable across restarts. */
  readonly id: string;
  readonly description: string;
  readonly input: S;
  readonly replay?: ToolReplay;
  /**
   * In the catalog but not offered until a session activates it, with a
   * result's `activate` or `session.tools.activate()`.
   */
  readonly deferred?: boolean;
  readonly native?: undefined;
  execute(
    input: InferInput<S>,
    context: ToolCallContext
  ): ToolResult | Promise<ToolResult>;
};

/**
 * A tool the harness brought itself, as the tool draft shows it. Its id,
 * description and `deferred` may change; its input schema and behaviour
 * may not. Return a portable `Tool` with the same id to replace it.
 */
export type NativeTool = {
  readonly id: string;
  readonly description: string;
  readonly deferred?: boolean;
  /** The schema the harness validates with. Read-only. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The harness's own handle on the tool. Opaque. */
  readonly native: NativeToolHandle;
};

/** Opaque handle from a harness adapter to one of its native tools. */
export type NativeToolHandle = { readonly harness: string };

/** An entry of the tool draft. */
export type ToolEntry = Tool | NativeTool;

/**
 * Whether a tool draft entry is the harness's own.
 *
 * @param entry - A tool draft entry.
 * @returns True for a native tool.
 */
export function isNativeTool(entry: ToolEntry): entry is NativeTool {
  return entry.native !== undefined;
}

/**
 * Type a tool declared outside `ctx.tool.add`, from its schema. An identity
 * function; `ctx.tool.add` infers the same types inline.
 *
 * @template S - The input schema; `execute`'s input is what it parses to.
 * @param tool - The tool.
 * @returns The same tool.
 */
export function tool<S extends ToolInputSchema<unknown>>(
  tool: Tool<S>
): Tool<S> {
  return tool;
}

/**
 * Edits the tool list during a rebuild. It starts with the harness's
 * native tools, then every transform runs over it.
 */
export type ToolDraft = {
  list(): readonly ToolEntry[];
  get(id: string): ToolEntry | undefined;
  /** Add a tool, replacing one with the same id, native or not. */
  add<S extends ToolInputSchema<unknown>>(tool: Tool<S>): void;
  /**
   * Replace an entry with what `update` returns; a missing id is ignored.
   * On a native tool this needs `tool.native.update`.
   */
  update(id: string, update: (entry: ToolEntry) => ToolEntry): void;
  /**
   * Remove an entry; a missing id is ignored. On a native tool this needs
   * `tool.native.remove`.
   */
  remove(id: string): void;
};

/**
 * A tool call about to run. Edit `input`, set `block` to refuse it, or set
 * `ask` to have the person approve it first.
 */
export type ToolBeforeEvent = {
  readonly tool: string;
  readonly session: string;
  readonly callId: string;
  input: JsonObject;
  /** Set to refuse the call; the model sees the reason. Stops later hooks. */
  block?: string;
  /**
   * Set to ask the person to confirm the call once every hook has run. A
   * refusal blocks it. Needs `tool.ask`.
   */
  ask?: string;
};

/** A tool call that has run. Replace `result` to change what the model sees. */
export type ToolAfterEvent = {
  readonly tool: string;
  readonly session: string;
  readonly callId: string;
  readonly input: JsonObject;
  result: ToolResult;
};

/** Hook events, by name. */
export type ToolHookEvents = {
  readonly "execute.before": ToolBeforeEvent;
  readonly "execute.after": ToolAfterEvent;
};

/** The `tool` domain. Hooks see every tool call, native tools included. */
export type ToolDomain = TransformDomain<ToolDraft> & {
  /** Add a tool: a transform that adds it, replacing any with its id. */
  add<S extends ToolInputSchema<unknown>>(tool: Tool<S>): Registration;
  /** Run `handler` on every call's event of this name, in order. */
  hook<Name extends keyof ToolHookEvents>(
    name: Name,
    handler: (event: ToolHookEvents[Name]) => void | Promise<void>
  ): Registration;
};

// ── Instructions ──────────────────────────────────────────────────────────

/**
 * Edits the system prompt's sections during a rebuild. Sections render in
 * the order they were first set.
 */
export type InstructionsDraft = {
  list(): readonly { readonly key: string; readonly text: string }[];
  get(key: string): string | undefined;
  set(key: string, text: string): void;
  remove(key: string): void;
};

/** The `instructions` domain: named system prompt sections. */
export type InstructionsDomain = TransformDomain<InstructionsDraft> & {
  /** Set one section: a transform that sets it. */
  set(key: string, text: string): Registration;
};

// ── Skills ────────────────────────────────────────────────────────────────

/** Edits the skill sources during a rebuild. */
export type SkillDraft = {
  list(): readonly SkillSource[];
  /** Add a source, replacing one with the same id. */
  add(source: SkillSource): void;
  remove(id: string): void;
};

/** The `skill` domain: `agents/skills` sources. */
export type SkillDomain = TransformDomain<SkillDraft> & {
  /** Add a skill source: a transform that adds it. */
  add(source: SkillSource): Registration;
};

// ── Commands ──────────────────────────────────────────────────────────────

/**
 * What a command returns. A `prompt` is submitted to the session as an
 * ordinary, durable operation, so a command that only rewrites the input
 * (a prompt template) survives eviction like any prompt. `text` is shown
 * as the command's answer and goes nowhere near the model.
 */
export type CommandResult =
  | void
  | { readonly prompt: string }
  | { readonly text: string };

/**
 * A slash command. The harness runs it when a session is sent
 * `/<name> <args>`, before anything is stored, so `run` must be safe to
 * repeat if the caller retries.
 */
export type Command = {
  /** Without the slash. */
  readonly name: string;
  readonly description: string;
  run(
    args: string,
    context: { readonly session: string }
  ): CommandResult | Promise<CommandResult>;
};

/** Edits the command list during a rebuild. */
export type CommandDraft = {
  list(): readonly Command[];
  get(name: string): Command | undefined;
  /** Add a command, replacing one with the same name. */
  add(command: Command): void;
  remove(name: string): void;
};

/** The `command` domain. */
export type CommandDomain = TransformDomain<CommandDraft> & {
  /** Add a command: a transform that adds it. */
  add(command: Command): Registration;
};

// ── Events ────────────────────────────────────────────────────────────────

/**
 * What happened in a session. Delivery is at least once: after an eviction
 * the harness may deliver an event again, so handlers must be idempotent.
 */
export type HarnessEvents = {
  /** A session was created by the harness's own API. */
  readonly "session.created": {
    readonly session: string;
    readonly parent?: string;
  };
  /** The model finished one message. */
  readonly "message.end": { readonly session: string; readonly text: string };
  /** A tool call finished, after every `execute.after` hook. */
  readonly "tool.end": {
    readonly session: string;
    readonly tool: string;
    readonly callId: string;
    readonly result: ToolResult;
  };
  /** The model gave its final answer for this run of the session. */
  readonly "turn.end": { readonly session: string; readonly text: string };
};

/** The `event` domain: observe a session. Handlers cannot change anything. */
export type EventDomain = {
  on<Name extends keyof HarnessEvents>(
    name: Name,
    handler: (event: HarnessEvents[Name]) => void | Promise<void>
  ): Registration;
};

// ── Storage and sessions ──────────────────────────────────────────────────

/** Synchronous durable key-value storage for one namespace. */
export type ExtensionStorage = {
  get<T extends JsonValue>(key: string): T | undefined;
  put(key: string, value: JsonValue): void;
  delete(key: string): boolean;
  /** Every key under `prefix`, in key order. */
  list(prefix?: string): readonly (readonly [string, JsonValue])[];
  /** The same namespace, scoped to one session. */
  session(id: string): ExtensionStorage;
};

/** One session, as an extension may drive it. */
export type ExtensionSession = {
  readonly id: string;
  /**
   * Submit input to the session as a durable operation. `operationId` is
   * required: a retried submit with the same id is not submitted twice.
   */
  submit(
    input: string,
    options: {
      readonly operationId: string;
      readonly whenBusy?: "followUp" | "steer";
    }
  ): Promise<{ readonly accepted: boolean }>;
  /**
   * Add a note to the transcript for clients to show. The model does not
   * see it. Deduplicated by `operationId` like `submit`.
   */
  note(
    text: string,
    options: { readonly operationId: string }
  ): Promise<{ readonly accepted: boolean }>;
  /** Which deferred tools this session is offered. */
  readonly tools: {
    activate(ids: readonly string[]): Promise<void>;
    deactivate(ids: readonly string[]): Promise<void>;
    /** Every tool the session is offered now, in order. */
    offered(): Promise<readonly string[]>;
  };
};
