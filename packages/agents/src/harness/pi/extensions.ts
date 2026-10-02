import type { Static, TSchema } from "@earendil-works/pi-ai";
import type {
  PromptInput,
  PromptSection,
  Registry,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from "@earendil-works/pi-durable";
import type {
  Extension,
  ExtensionContext,
  ExtensionDraft,
  Extensions,
  ExtensionState,
  ToolContext
} from "../extension";
import type { Context } from "./context";

/** What pi gives a running tool call, beyond every harness's `signal`. */
export interface PiToolContext extends ToolContext {
  /**
   * pi's operations for this call: `output`, `details`, `diagnostic`,
   * `memo`, `commit`, tasks, and `conversation` for subagents.
   */
  readonly api: ToolExecutionApi;
  /** pi's context for this call, to pass to `api`'s operations. */
  readonly context: Context;
}

/**
 * A pi tool, named by its key in `tools`. Everything pi's
 * `ToolRegistration` has (`replay`, `executionMode`, `prepareArguments`,
 * `outputLimits`) except its name and calling convention: `execute` gets
 * its arguments, typed by `parameters` and validated against them first,
 * and a `PiToolContext`.
 */
export type PiTool<Parameters extends TSchema = TSchema> = Omit<
  ToolRegistration<Parameters>,
  "name" | "execute"
> & {
  execute(
    args: Static<Parameters>,
    ctx: PiToolContext
  ): Promise<ToolExecutionResult>;
};

/** What a section is given when it renders, beyond every harness's `signal`. */
export interface PiSectionContext {
  readonly signal: AbortSignal;
}

/**
 * A system prompt section, named by its key in `prompt`. `render` runs
 * before each request, with pi's input: the conversation, its agent and
 * offered tools, and committed document reads. Wrapped in `<key>` tags
 * unless `tag` is false.
 */
export type PiSection = {
  readonly tag?: boolean;
  render(
    input: PromptInput,
    ctx: PiSectionContext
  ): string | undefined | Promise<string | undefined>;
};

/** The harness's tools, by name, as a transform edits them. */
export interface PiTools extends Omit<ExtensionDraft<PiTool>, "set"> {
  /** Add `tool` as `name`, or replace the tool with this name in place. */
  set<Parameters extends TSchema>(name: string, tool: PiTool<Parameters>): void;
}

/** The system prompt's sections, in order, as a transform edits them. */
export type PiPrompt = ExtensionDraft<PiSection>;

/** What a pi extension is given. */
export type PiExtensionContext = ExtensionContext<PiTools, PiPrompt>;

/**
 * A pi extension.
 *
 * ```ts
 * const preamble: PiExtension = (ctx) =>
 *   ctx.prompt.transform((prompt) =>
 *     prompt.set("preamble", { render: () => "Be brief.", tag: false })
 *   );
 * ```
 */
export type PiExtension = Extension<PiExtensionContext>;

/**
 * Extensions by name, run and applied in key order. Names are stored by pi
 * (a conversation selects extensions by name), so keep them stable.
 */
export type PiExtensions = Extensions<PiExtensionContext>;

/** A signal for pi's context, which may carry none. */
function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}

/** pi's `ToolRegistration` for one of our tools. */
function registration(name: string, tool: PiTool): ToolRegistration {
  return {
    ...tool,
    name,
    execute: (args, api, context) =>
      tool.execute(args, { signal: signalOf(context), api, context })
  };
}

/** pi's `PromptSection` for one of our sections. */
function promptSection(key: string, section: PiSection): PromptSection {
  return {
    key,
    ...(section.tag === undefined ? {} : { tag: section.tag }),
    render: (input, context) =>
      section.render(input, { signal: signalOf(context) })
  };
}

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
  for (const name of Object.keys(extensions)) {
    // JavaScript orders integer-like keys before every other key, so one
    // would silently run first.
    if (/^(0|[1-9]\d*)$/.test(name)) {
      throw new Error(
        `pi extension name ${JSON.stringify(name)} looks like an array index, which would reorder the extensions; use a name with a letter in it`
      );
    }
  }
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
        .map(([key, tool]) => registration(key, tool)),
      sections: builtPrompt
        .owned(name)
        .map(([key, section]) => promptSection(key, section))
    };
    if (owned.tools.length === 0 && owned.sections.length === 0) continue;
    registry.install({ name, ...owned });
  }
}
