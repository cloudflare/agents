import type { SkillSource } from "../../skills";
import type { InferInput, JsonObject, ToolInputSchema } from "./schema";

/**
 * The portable extension format: one shape that runs on every harness.
 *
 * An extension is code. Its `setup` registers two kinds of things on the
 * context it is handed:
 *
 * - **Transforms** over a domain (`tool`, `instructions`, `skill`). A
 *   transform edits a draft. The harness rebuilds a domain by starting from
 *   an empty draft and running every transform once, in order, so a rebuild
 *   always gives the same result and never stacks an edit twice. Call the
 *   domain's `reload()` when data a transform closes over has changed.
 * - **Hooks** on a running operation (`tool.hook("execute.before")`). A hook
 *   edits the event it is handed; later hooks see earlier hooks' edits.
 *   Hooks are never replayed.
 *
 * Every registration returns a `Registration`; disposing it removes it and
 * rebuilds the domain. Removing an extension disposes all of them.
 *
 * The API is a subset of OpenCode 2's plugin API, with the same names.
 */

/** A registered transform or hook. */
export type Registration = {
  /** Remove the registration and rebuild its domain. Idempotent. */
  readonly dispose: () => Promise<void>;
};

/** What `setup` may return: cleanup run when the extension is removed. */
export type Cleanup = () => void | Promise<void>;

/**
 * A portable extension.
 *
 * `setup` runs every time the harness starts, which on a Durable Object
 * means after every eviction. Keep what must survive in storage the
 * extension owns, and give tools ids that do not change between runs: a
 * harness resumes an interrupted tool call by its tool's id.
 */
export type Extension = {
  /** Unique among the extensions on one harness. */
  readonly id: string;
  readonly setup: (
    context: ExtensionContext
  ) => void | Cleanup | Promise<void | Cleanup>;
};

/** A feature a harness may or may not support. */
export type ExtensionFeature =
  | "tool"
  | "tool.execute.before"
  | "tool.execute.after"
  | "instructions"
  | "skill";

/** What `setup` is handed. */
export type ExtensionContext = {
  /** The harness running the extension, such as `"pi"` or `"opencode"`. */
  readonly harness: string;
  /**
   * Whether this harness supports a feature. Registering an unsupported
   * transform or hook throws `ExtensionFeatureUnsupported`, which fails the
   * extension's setup; check first to degrade instead.
   */
  supports(feature: ExtensionFeature): boolean;
  readonly tool: ToolDomain;
  readonly instructions: InstructionsDomain;
  readonly skill: SkillDomain;
};

/** A domain whose value is rebuilt from transforms. */
export type TransformDomain<Draft> = {
  /** Register a transform and rebuild the domain with it. */
  transform(
    edit: (draft: Draft) => void | Promise<void>
  ): Promise<Registration>;
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
};

/** What a tool's `execute` is handed besides its input. */
export type ToolCallContext = {
  /** The session the call belongs to, as the harness names it. */
  readonly session: string;
  /** The model's id for this call. */
  readonly callId: string;
  /** Aborts when the call is cancelled. */
  readonly signal: AbortSignal;
  /** Report progress a client can show while the tool runs. */
  progress(text: string): void;
};

/**
 * What happens to a call the object was evicted during.
 *
 * - `unsafe` (default): report the call as interrupted; do not run it again.
 * - `safe`: run it again. For reads and idempotent writes.
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
  execute(
    input: InferInput<S>,
    context: ToolCallContext
  ): ToolResult | Promise<ToolResult>;
};

/**
 * Type a tool from its schema. An identity function.
 *
 * @template S - The input schema; `execute`'s input is what it parses to.
 * @param tool - The tool.
 * @returns The same tool.
 */
export function defineTool<S extends ToolInputSchema<unknown>>(
  tool: Tool<S>
): Tool<S> {
  return tool;
}

/** Edits the tool list during a rebuild. */
export type ToolDraft = {
  list(): readonly Tool[];
  get(id: string): Tool | undefined;
  /** Add a tool, replacing one with the same id. */
  add<S extends ToolInputSchema<unknown>>(tool: Tool<S>): void;
  /** Replace a tool with what `update` returns; a missing id is ignored. */
  update(id: string, update: (tool: Tool) => Tool): void;
  /** Remove a tool; a missing id is ignored. */
  remove(id: string): void;
};

/** A tool call about to run. Edit `input`, or set `block` to refuse it. */
export type ToolBeforeEvent = {
  readonly tool: string;
  readonly session: string;
  readonly callId: string;
  input: JsonObject;
  /** Set to refuse the call; the model sees the reason. Stops later hooks. */
  block?: string;
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
  hook<Name extends keyof ToolHookEvents>(
    name: Name,
    handler: (event: ToolHookEvents[Name]) => void | Promise<void>
  ): Promise<Registration>;
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
export type InstructionsDomain = TransformDomain<InstructionsDraft>;

// ── Skills ────────────────────────────────────────────────────────────────

/** Edits the skill sources during a rebuild. */
export type SkillDraft = {
  list(): readonly SkillSource[];
  /** Add a source, replacing one with the same id. */
  add(source: SkillSource): void;
  remove(id: string): void;
};

/** The `skill` domain: `agents/skills` sources. */
export type SkillDomain = TransformDomain<SkillDraft>;

/**
 * Type an extension. An identity function.
 *
 * @param extension - The extension.
 * @returns The same extension.
 */
export function defineExtension(extension: Extension): Extension {
  return extension;
}
