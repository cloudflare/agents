/**
 * What every harness's extensions share. An extension is a plain function
 * of a harness-specific context. It does not mutate a harness's tools or
 * prompt; it registers transforms on them. The harness builds each state
 * from empty by running every transform once, in registration order, so
 * the result depends only on which extensions are installed and in what
 * order, never on how often anything ran.
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
