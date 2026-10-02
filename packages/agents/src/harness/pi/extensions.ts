import type { TSchema } from "@earendil-works/pi-ai";
import type {
  PromptSection,
  Registry,
  ToolRegistration
} from "@earendil-works/pi-durable";
import type { ExtensionDraft, ExtensionState } from "../extension";

/**
 * A pi tool, named by its key in `tools`. `execute`'s arguments are typed
 * by `parameters`, which pi validates them against first.
 */
export type PiTool<Parameters extends TSchema = TSchema> = Omit<
  ToolRegistration<Parameters>,
  "name"
>;

/** A system prompt section, named by its key in `prompt`. */
export type PiSection = Omit<PromptSection, "key">;

/** The harness's tools, by name, as a transform edits them. */
export interface PiTools extends Omit<ExtensionDraft<PiTool>, "set"> {
  /** Add `tool` as `name`, or replace the tool with this name in place. */
  set<Parameters extends TSchema>(name: string, tool: PiTool<Parameters>): void;
}

/** The system prompt's sections, in order, as a transform edits them. */
export type PiPrompt = ExtensionDraft<PiSection>;

/** What a pi extension is given. */
export interface PiExtensionContext {
  /** The key this extension was installed under. */
  readonly name: string;
  readonly tools: ExtensionState<PiTools>;
  readonly prompt: ExtensionState<PiPrompt>;
}

/**
 * A pi extension: a function that registers transforms on the harness's
 * tools and prompt. It may be async, to load what it contributes; its
 * transforms must be registered before it returns.
 *
 * ```ts
 * const preamble: PiExtension = (ctx) =>
 *   ctx.prompt.transform((prompt) =>
 *     prompt.set("preamble", { render: () => "Be brief.", tag: false })
 *   );
 * ```
 */
export type PiExtension = (ctx: PiExtensionContext) => void | Promise<void>;

/** Extensions by name, run and applied in key order. */
export type PiExtensions = Readonly<Record<string, PiExtension>>;

type Transform<Draft> = {
  readonly owner: string;
  readonly change: (draft: Draft) => void;
};

/**
 * A draft that remembers which extension added each entry. A replaced
 * entry keeps its owner, so a later extension that rewrites another's tool
 * changes it where it lives.
 */
class OwnedDraft<Value> implements ExtensionDraft<Value> {
  readonly #entries = new Map<
    string,
    { readonly owner: string; readonly value: Value }
  >();
  /** The extension whose transform is running. */
  owner = "";

  get(name: string): Value | undefined {
    return this.#entries.get(name)?.value;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  set(name: string, value: Value): void {
    const owner = this.#entries.get(name)?.owner ?? this.owner;
    this.#entries.set(name, { owner, value });
  }

  delete(name: string): boolean {
    return this.#entries.delete(name);
  }

  keys(): IterableIterator<string> {
    return this.#entries.keys();
  }

  /** The entries `owner` added, in insertion order. */
  owned(owner: string): [string, Value][] {
    return [...this.#entries]
      .filter(([, entry]) => entry.owner === owner)
      .map(([name, entry]) => [name, entry.value]);
  }
}

/** Run every transform once, in order, over an empty draft. */
function build<Value, Draft>(
  transforms: readonly Transform<Draft>[],
  draft: OwnedDraft<Value> & Draft
): OwnedDraft<Value> {
  for (const { owner, change } of transforms) {
    draft.owner = owner;
    change(draft);
  }
  return draft;
}

/**
 * Run `extensions` in order, build the tools and prompt from their
 * transforms, and install one pi extension per extension that contributed
 * anything, under its name, so a conversation can still select it.
 */
export async function installExtensions(
  registry: Registry,
  extensions: PiExtensions
): Promise<void> {
  const tools: Transform<PiTools>[] = [];
  const prompt: Transform<PiPrompt>[] = [];

  for (const [name, extension] of Object.entries(extensions)) {
    let installing = true;
    const state = <Draft>(into: Transform<Draft>[]): ExtensionState<Draft> => ({
      transform(change) {
        if (!installing) {
          throw new Error(
            `pi extension ${JSON.stringify(name)} registered a transform after it was installed`
          );
        }
        into.push({ owner: name, change });
      }
    });
    try {
      await extension({ name, tools: state(tools), prompt: state(prompt) });
    } finally {
      installing = false;
    }
  }

  const builtTools = build(tools, new OwnedDraft<PiTool>());
  const builtPrompt = build(prompt, new OwnedDraft<PiSection>());
  for (const name of Object.keys(extensions)) {
    const owned = {
      tools: builtTools
        .owned(name)
        .map(([key, tool]) => ({ ...tool, name: key })),
      sections: builtPrompt
        .owned(name)
        .map(([key, section]) => ({ ...section, key }))
    };
    if (owned.tools.length === 0 && owned.sections.length === 0) continue;
    registry.install({ name, ...owned });
  }
}
