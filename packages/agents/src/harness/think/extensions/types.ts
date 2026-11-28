/**
 * ThinkHarness's extensions: what an extension writes, and what crosses
 * between an extension and the harness.
 *
 * The rule every part of this API follows: nothing is in it that cannot be
 * the same in the harness's isolate and across Workers RPC. So what an
 * extension registers is split in two. Data crosses: tool entries, prompt
 * entries, hook contexts and hook results. Functions stay beside the
 * extension, kept by its runtime, and the harness reaches them through the
 * extension's handle.
 *
 * @internal Not exported from any entry point.
 */
import type { JSONSchema7, ModelMessage, Tool } from "ai";
import type {
  ThinkErrorClass,
  ThinkHookContext,
  ThinkRecoveryContext,
  ThinkRecoveryDecision,
  ThinkSessionId,
  ThinkStepFinishContext,
  ThinkToolCallContext,
  ThinkToolCallDecision,
  ThinkToolCallResultContext,
  ThinkTurnEndContext,
  ToolRecovery
} from "../types";

/** What a build is for. @internal */
export type BuildContext = {
  readonly session: ThinkSessionId;
};

/**
 * A tool as the harness holds it: data only. The functions behind it stay
 * with the extension that set it, its `owner`.
 *
 * @internal
 */
export type ToolEntry = {
  /** The extension that set this tool last, and runs it. */
  readonly owner: string;
  /**
   * The tool's data fields as its author gave them (`description`, `type`,
   * `id`, `args`, `providerOptions`, `strict`, `recovery`, ...).
   */
  readonly definition: Readonly<Record<string, unknown>>;
  /** As the AI SDK sends it to the model. */
  readonly inputSchema: JSONSchema7;
  readonly outputSchema?: JSONSchema7;
  /** Which of the tool's functions the owner keeps. */
  readonly execute: boolean;
  /** The input schema validates (and may transform) a call's input. */
  readonly validate: boolean;
  /** The tool converts its output for the model (`toModelOutput`). */
  readonly modelOutput: boolean;
  /**
   * The tool's `execute` is an async generator: it streams outputs, and
   * each one before the last is preliminary.
   */
  readonly streams: boolean;
  /** `"always"`, or `"call"` to ask the owner per call. */
  readonly approval?: "always" | "call";
};

/**
 * A prompt section, by key. One with `whenChanged: "remind"` is a block of
 * the session's context instead of system text: it is in the prompt the
 * context records, and a change to it reaches the model once, as a
 * reminder, without rewriting that prompt.
 *
 * @internal
 */
export type PromptSection = {
  readonly text: string;
  readonly whenChanged?: "remind";
  readonly description?: string;
  readonly maxTokens?: number;
};

/** A prompt section as the harness holds it. @internal */
export type PromptEntry = PromptSection & { readonly owner: string };

/** Tools and prompt as a build passes them along. Ordered. @internal */
export type Drafts = {
  readonly tools: readonly (readonly [string, ToolEntry])[];
  readonly prompt: readonly (readonly [string, PromptEntry])[];
};

/** A tool as an extension sets it: an AI SDK tool. @internal */
export type ExtensionTool = Tool & { readonly recovery?: ToolRecovery };

/**
 * A named, ordered collection a transform edits. Setting a name already
 * present replaces it in place; `get` returns data only.
 *
 * @internal
 */
export interface Draft<Value, Entry> {
  get(name: string): Entry | undefined;
  has(name: string): boolean;
  set(name: string, value: Value): void;
  delete(name: string): boolean;
  keys(): IterableIterator<string>;
}

/** Who may call a tool: the model, other tools' code (`invoke`), or both. @internal */
export type ToolCaller = "model" | "code";

/** @internal */
export interface ToolDraft extends Draft<ExtensionTool, ToolEntry> {
  /**
   * Say who may call a tool that is already set, whoever set it: its
   * owner keeps running it. Returns false when there is no such tool.
   */
  setCallers(name: string, callers: readonly ToolCaller[]): boolean;
}
/** @internal */
export type PromptDraft = Draft<PromptSection, PromptEntry>;

/** @internal */
export type Transform<D> = (
  draft: D,
  build: BuildContext
) => void | Promise<void>;

/**
 * Hooks by name, each with its context and what a handler may return.
 * Contexts and results are data.
 *
 * @internal
 */
export type HookMap = Readonly<Record<string, readonly [unknown, unknown]>>;

/**
 * How the handlers of each hook in `M` combine: given a context and the
 * handlers in order, the hook's result.
 *
 * @internal
 */
export type HookRules<M extends HookMap> = {
  readonly [H in keyof M]: (
    context: M[H][0],
    handlers: readonly HookHandler<M[H][0], M[H][1]>[]
  ) => Promise<M[H][1]>;
};

/** One extension's handlers of a hook, named after the extension. @internal */
export type HookHandler<C, R> = ((context: C) => Promise<R>) & {
  readonly extension: string;
};

/**
 * ThinkHarness's hooks.
 *
 * @internal
 */
export type ExtensionHooks = {
  beforeToolCall: [ThinkToolCallContext, ThinkToolCallDecision | void];
  afterToolCall: [ThinkToolCallResultContext, void];
  onStepFinish: [ThinkStepFinishContext, void];
  onTurnEnd: [ThinkTurnEndContext, void];
  onError: [{ readonly error: unknown } & ThinkHookContext, void];
  classifyError: [{ readonly error: unknown }, ThinkErrorClass | void];
  onRecovery: [ThinkRecoveryContext, ThinkRecoveryDecision | void];
};

/** @internal */
export type ExtensionHookHandler<
  H extends keyof M & string,
  M extends HookMap = ExtensionHooks
> = (context: M[H][0]) => M[H][1] | Promise<M[H][1]>;

/** What an extension is given, with the hooks of `M`. @internal */
export type ExtensionContext<M extends HookMap = ExtensionHooks> = {
  /** The name it was loaded under. */
  readonly name: string;
  readonly tools: { transform(change: Transform<ToolDraft>): void };
  readonly prompt: { transform(change: Transform<PromptDraft>): void };
  on<H extends keyof M & string>(
    hook: H,
    handler: ExtensionHookHandler<H, M>
  ): void;
};

/**
 * An extension: a function that registers transforms and hooks before it
 * returns. It runs once, when it is loaded.
 *
 * @internal
 */
export type ThinkExtension<M extends HookMap = ExtensionHooks> = (
  ctx: ExtensionContext<M>
) => void | Promise<void>;

/**
 * How the runtime turns a tool's input schema into JSON Schema and a
 * validator. In process it is the AI SDK's `asSchema`; in a Worker, where
 * a tool's schema is JSON Schema already, it passes it through.
 *
 * @internal
 */
export type SchemaOf = (schema: unknown) => {
  readonly jsonSchema: JSONSchema7 | PromiseLike<JSONSchema7>;
  readonly validate?: (value: unknown) => Validation | PromiseLike<Validation>;
};

/** A tool call as its owner sees it. @internal */
export type ToolCall = {
  readonly id: string;
  readonly session: ThinkSessionId;
  readonly messages: ModelMessage[];
};

/** A tool call's outcome. @internal */
export type ToolOutcome =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly errorText: string };

/**
 * Call another tool through the harness, from a tool's `execute` (its
 * options' `invoke`): a recorded step under the calling one, with the
 * tool hooks. A tool whose `callers` leaves out `"code"` refuses.
 *
 * @internal
 */
export type ToolInvoke = (tool: string, input: unknown) => Promise<ToolOutcome>;

/** A validated input, or why it is not valid. @internal */
export type Validation =
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false; readonly error: Error };

/**
 * A loaded extension, as the harness reaches it. A loader returns one;
 * every argument and result is structured-clone data or, for `onOutput`,
 * a function, which Workers RPC passes as a stub.
 *
 * @internal
 */
export interface ExtensionHandle<M extends HookMap = ExtensionHooks> {
  describe(): Promise<{ readonly hooks: readonly (keyof M & string)[] }>;
  /** Run this extension's transforms over what the ones before it built. */
  build(drafts: Drafts, build: BuildContext): Promise<Drafts>;
  /**
   * Run a tool. A streaming tool's outputs go to `onOutput` as it yields
   * them, awaited in order, and its last is also the outcome's. `invoke`,
   * when the harness gives one, is the tool's `options.invoke`.
   */
  execute(
    tool: string,
    input: unknown,
    call: ToolCall,
    onOutput: (output: unknown) => void | Promise<void>,
    invoke?: ToolInvoke
  ): Promise<ToolOutcome>;
  /** Abort a running call's `abortSignal`, with `reason`. */
  cancel(call: Pick<ToolCall, "id" | "session">, reason?: unknown): void;
  validate(
    tool: string,
    input: unknown,
    build: BuildContext
  ): Promise<Validation>;
  modelOutput(
    tool: string,
    output: { toolCallId: string; input: unknown; output: unknown },
    build: BuildContext
  ): Promise<unknown>;
  needsApproval(tool: string, input: unknown, call: ToolCall): Promise<boolean>;
  hook<H extends keyof M & string>(name: H, context: M[H][0]): Promise<M[H][1]>;
}
