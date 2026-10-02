/**
 * The shape every harness's extensions share.
 *
 * An extension is a plain function of its harness's context. It does not
 * mutate the harness's tools or prompt; it registers transforms on them.
 * The harness builds each state from empty by running every transform
 * once, in registration order, so the result depends only on which
 * extensions are installed and in what order, never on how often anything
 * ran.
 *
 * What a tool or a section can do differs per harness: each harness types
 * its own drafts and tool context on top of these, so an extension written
 * for one harness reads the same on another, and uses what that harness
 * offers.
 *
 * @experimental The API may change between releases.
 */

/** One thing extensions build together, such as a harness's tools. */
export interface ExtensionState<Draft> {
  /**
   * Register a change to this state. `change` edits a draft that holds what
   * the transforms before it built, and runs on every build.
   */
  transform(change: (draft: Draft) => void): void;
}

/** A named, ordered collection an extension edits inside a transform. */
export interface ExtensionDraft<Value> {
  get(name: string): Value | undefined;
  has(name: string): boolean;
  /** Add `value`, or replace the entry with this name in place. */
  set(name: string, value: Value): void;
  delete(name: string): boolean;
  keys(): IterableIterator<string>;
}

/** What every harness gives an extension. */
export interface ExtensionContext<Tools, Prompt> {
  /** The key this extension was installed under. */
  readonly name: string;
  /** The harness's tools, by name. */
  readonly tools: ExtensionState<Tools>;
  /** The system prompt's sections, by key, in order. */
  readonly prompt: ExtensionState<Prompt>;
}

/**
 * An extension: a function that registers transforms on its harness's
 * context. It may be async, to load what it contributes; its transforms
 * must be registered before it returns.
 */
export type Extension<Context> = (ctx: Context) => void | Promise<void>;

/** Extensions by name, run and applied in key order. */
export type Extensions<Context> = Readonly<Record<string, Extension<Context>>>;

/** What every harness gives a running tool call. */
export interface ToolContext {
  /** Aborted when the call is: the run was aborted, or the object is stopping. */
  readonly signal: AbortSignal;
}
