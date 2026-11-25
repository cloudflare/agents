/**
 * The extensions a harness has loaded, in order, and what they build
 * together. Held in memory: one entry per loaded extension.
 *
 * A build starts from empty drafts and passes them through each
 * extension's `build` in load order, so each sees what the ones before it
 * made, and a later `set` of a name takes the tool over, execution
 * included. The result depends only on what is loaded and in what order.
 *
 * The manager is generic over its hooks: ThinkHarness's (`harnessHookRules`)
 * and the hooks `Think` gives the extensions it loads from source.
 *
 * @internal Sibling-package support through `agents/internal`.
 */
import { jsonSchema, type ModelMessage, type Tool, type ToolSet } from "ai";
import type { ThinkSessionId } from "../types";
import type {
  Drafts,
  ExtensionHandle,
  ExtensionHooks,
  HookMap,
  HookRules,
  ToolEntry
} from "./types";

type Loaded<M extends HookMap> = {
  readonly handle: ExtensionHandle<M>;
  readonly hooks: ReadonlySet<string>;
};

/** What the loaded extensions built for one session. @internal */
export type ExtensionBuild = {
  /**
   * The tools as the AI SDK takes them. Each function on them (`execute`,
   * input validation, `toModelOutput`, `needsApproval`) calls the tool's
   * owner through its handle.
   */
  readonly tools: ToolSet;
  /**
   * The text of the sections that are not remind blocks, in order, or
   * nothing if there are none.
   */
  readonly system: string | undefined;
  /** The sections that are remind blocks, labelled by their keys. */
  readonly remind: readonly RemindSection[];
  /**
   * Every section's text, remind blocks included, in order: the system
   * text for a session that has no context to hold the remind blocks.
   */
  readonly allSections: string | undefined;
};

/** A remind section, as a context block takes it. @internal */
export type RemindSection = {
  readonly label: string;
  readonly text: string;
  readonly description?: string;
  readonly maxTokens?: number;
};

const NO_DRAFTS: Drafts = { tools: [], prompt: [] };

/** @internal */
export class ExtensionManager<M extends HookMap = ExtensionHooks> {
  readonly #rules: HookRules<M>;
  #loaded: {
    readonly name: string;
    readonly ready: Promise<Loaded<M>>;
  }[] = [];

  constructor(rules: HookRules<M>) {
    this.#rules = rules;
  }

  /** Add an extension after those already loaded. */
  load(name: string, handle: Promise<ExtensionHandle<M>>): void {
    if (this.#loaded.some((loaded) => loaded.name === name)) {
      throw new Error(`An extension named "${name}" is already loaded`);
    }
    const ready = handle.then(async (loaded) => ({
      handle: loaded,
      hooks: new Set((await loaded.describe()).hooks)
    }));
    // Its error is reported by the first build or hook that needs it.
    ready.catch(() => {});
    this.#loaded.push({ name, ready });
  }

  /** Remove an extension; the next build is made without it. */
  unload(name: string): boolean {
    const before = this.#loaded.length;
    this.#loaded = this.#loaded.filter((loaded) => loaded.name !== name);
    return this.#loaded.length < before;
  }

  async #all(): Promise<(Loaded<M> & { readonly name: string })[]> {
    return Promise.all(
      this.#loaded.map(async ({ name, ready }) => ({ name, ...(await ready) }))
    );
  }

  async build(session: ThinkSessionId): Promise<ExtensionBuild> {
    const loaded = await this.#all();
    let drafts = NO_DRAFTS;
    for (const { handle } of loaded) {
      drafts = await handle.build(drafts, { session });
    }
    return {
      tools: toolsOf(
        drafts.tools,
        new Map(loaded.map(({ name, handle }) => [name, handle])),
        session
      ),
      ...promptOf(drafts.prompt)
    };
  }

  /** Run hook `name`'s handlers across the extensions, in order. */
  async hook<H extends keyof M & string>(
    name: H,
    context: M[H][0]
  ): Promise<M[H][1]> {
    const loaded = await this.#all();
    return this.#rules[name](
      context,
      loaded
        .filter(({ hooks }) => hooks.has(name))
        .map(({ name: extension, handle }) =>
          Object.assign((current: M[H][0]) => handle.hook(name, current), {
            extension
          })
        )
    );
  }

  /** Whether any loaded extension subscribes to hook `name`. */
  async subscribed(name: keyof M & string): Promise<boolean> {
    return (await this.#all()).some(({ hooks }) => hooks.has(name));
  }
}

/** The system text of the plain sections, and the remind sections. */
function promptOf(
  prompt: Drafts["prompt"]
): Pick<ExtensionBuild, "system" | "remind" | "allSections"> {
  const plain = prompt.filter(([, section]) => !section.whenChanged);
  return {
    allSections:
      prompt.length === 0
        ? undefined
        : prompt.map(([, section]) => section.text).join("\n\n"),
    system:
      plain.length === 0
        ? undefined
        : plain.map(([, section]) => section.text).join("\n\n"),
    remind: prompt
      .filter(([, section]) => section.whenChanged === "remind")
      .map(([label, { text, description, maxTokens }]) => ({
        label,
        text,
        ...(description !== undefined && { description }),
        ...(maxTokens !== undefined && { maxTokens })
      }))
  };
}

/**
 * The AI SDK tools over built entries, whose functions call each entry's
 * owner in `owners`.
 *
 * @internal
 */
export function toolsOf<M extends HookMap>(
  entries: Drafts["tools"],
  owners: ReadonlyMap<string, ExtensionHandle<M>>,
  session: ThinkSessionId
): ToolSet {
  const tools: ToolSet = {};
  for (const [name, entry] of entries) {
    const owner = owners.get(entry.owner);
    if (!owner) throw new Error(`No extension "${entry.owner}" is loaded`);
    tools[name] = toolOf(name, entry, owner, session);
  }
  return tools;
}

/** An AI SDK tool over an entry, whose functions call its owner. */
function toolOf<M extends HookMap>(
  name: string,
  entry: ToolEntry,
  owner: ExtensionHandle<M>,
  session: ThinkSessionId
): Tool {
  const build = { session };
  const call = (options: { toolCallId: string; messages: ModelMessage[] }) => ({
    id: options.toolCallId,
    session,
    messages: options.messages
  });
  // SAFETY: an entry's definition holds the data fields of an AI SDK tool
  // of the same kind; the fields set here complete it.
  return {
    ...entry.definition,
    inputSchema: jsonSchema(
      entry.inputSchema,
      entry.validate
        ? { validate: (value) => owner.validate(name, value, build) }
        : undefined
    ),
    ...(entry.modelOutput && {
      toModelOutput: async (output) =>
        // SAFETY: the owner returns what the tool's toModelOutput returned.
        (await owner.modelOutput(name, output, build)) as Awaited<
          ReturnType<NonNullable<Tool["toModelOutput"]>>
        >
    }),
    ...(entry.approval === "always" && { needsApproval: true }),
    ...(entry.approval === "call" && {
      needsApproval: (input, options) =>
        owner.needsApproval(name, input, call(options))
    }),
    ...(entry.execute && {
      execute: (input, options) => {
        const run = execute(
          owner,
          name,
          input,
          call(options),
          options.abortSignal
        );
        // The AI SDK streams whatever returns an async iterable, so a tool
        // declared as an async generator returns its outputs as they come.
        // Any other tool returns its one result, or, when what it returned
        // turns out to stream, a promise of the outputs. ThinkHarness's
        // executeTool awaits before it checks for an iterable, so it streams
        // them. The AI SDK's checks first, so a tool it runs would get the
        // outputs object as its result. Its only such caller is Think's
        // sandboxed extensions, whose results never stream.
        // TODO(E4): decide this from the result on the AI SDK path too.
        if (entry.streams) return run.outputs;
        return run.streams.then((streams) =>
          streams ? run.outputs : lastOf(run.outputs)
        );
      }
    })
  } as Tool;
}

async function lastOf(outputs: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const output of outputs) last = output;
  return last;
}

/**
 * Run a tool through its owner. `outputs` yields what the tool yields,
 * when it yields it (or its one result), and throws the owner's error
 * text, so whoever runs it sees the same outputs as from the tool itself.
 * `streams` says, as soon as it is known, whether the tool streamed. A
 * call whose signal is already aborted never starts.
 */
function execute<M extends HookMap>(
  owner: ExtensionHandle<M>,
  name: string,
  input: unknown,
  call: {
    id: string;
    session: ThinkSessionId;
    messages: ModelMessage[];
  },
  signal: AbortSignal | undefined
): { outputs: AsyncGenerator<unknown>; streams: Promise<boolean> } {
  signal?.throwIfAborted();
  const outputs: unknown[] = [];
  let streamed = false;
  let wake: (() => void) | undefined;
  let knowStreams: (streams: boolean) => void = () => {};
  const streams = new Promise<boolean>((resolve) => {
    knowStreams = resolve;
  });
  const onAbort = () => owner.cancel(call, signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let settled = false;
  const done = owner
    .execute(name, input, call, (output) => {
      streamed = true;
      knowStreams(true);
      outputs.push(output);
      wake?.();
    })
    .finally(() => {
      settled = true;
      knowStreams(streamed);
      wake?.();
    });
  // Settled through `outputs`; this only keeps a failure that nobody
  // iterates from being reported as unhandled.
  done.catch(() => {});
  async function* drain(): AsyncGenerator<unknown> {
    try {
      for (;;) {
        while (outputs.length > 0) yield outputs.shift();
        if (settled) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      const outcome = await done;
      if (!outcome.ok) throw new Error(outcome.errorText);
      // A streaming tool's last output was its result, already yielded.
      if (!streamed) yield outcome.output;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return { outputs: drain(), streams };
}
