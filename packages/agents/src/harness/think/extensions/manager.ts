/**
 * The extensions a harness has loaded, in order, and what they build
 * together. Held in memory: one entry per loaded extension.
 *
 * A build starts from empty drafts and passes them through each
 * extension's `build` in load order, so each sees what the ones before it
 * made, and a later `set` of a name takes the tool over, execution
 * included. The result depends only on what is loaded and in what order.
 *
 * @internal Not exported from any entry point.
 */
import { jsonSchema, type ModelMessage, type Tool, type ToolSet } from "ai";
import type { ThinkSessionId } from "../types";
import { dispatchHook } from "./hooks";
import type {
  Drafts,
  ExtensionHandle,
  ExtensionHookName,
  ExtensionHooks,
  ToolEntry
} from "./types";

type Loaded = {
  readonly handle: ExtensionHandle;
  readonly hooks: ReadonlySet<ExtensionHookName>;
};

/** What the loaded extensions built for one session. @internal */
export type ExtensionBuild = {
  /**
   * The tools as the AI SDK takes them. Each function on them (`execute`,
   * input validation, `toModelOutput`, `needsApproval`) calls the tool's
   * owner through its handle.
   */
  readonly tools: ToolSet;
  /** The prompt sections' text, in order, or nothing if there are none. */
  readonly system: string | undefined;
};

const NO_DRAFTS: Drafts = { tools: [], prompt: [] };

/** @internal */
export class ExtensionManager {
  readonly #loaded: {
    readonly name: string;
    readonly ready: Promise<Loaded>;
  }[] = [];

  /** Add an extension after those already loaded. */
  load(name: string, handle: Promise<ExtensionHandle>): void {
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

  async #all(): Promise<(Loaded & { readonly name: string })[]> {
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
    const owners = new Map(loaded.map(({ name, handle }) => [name, handle]));
    const tools: ToolSet = {};
    for (const [name, entry] of drafts.tools) {
      const owner = owners.get(entry.owner);
      if (!owner) throw new Error(`No extension "${entry.owner}" is loaded`);
      tools[name] = toolOf(name, entry, owner, session);
    }
    return {
      tools,
      system:
        drafts.prompt.length === 0
          ? undefined
          : drafts.prompt.map(([, section]) => section.text).join("\n\n")
    };
  }

  /** Run hook `name`'s handlers across the extensions, in order. */
  async hook<H extends ExtensionHookName>(
    name: H,
    context: ExtensionHooks[H][0]
  ): Promise<ExtensionHooks[H][1]> {
    const loaded = await this.#all();
    return dispatchHook(
      name,
      context,
      loaded
        .filter(({ hooks }) => hooks.has(name))
        .map(
          ({ handle }) =>
            // SAFETY: dispatchHook passes each runner a context of hook `name`.
            (current: unknown) =>
              handle.hook(name, current as ExtensionHooks[H][0])
        )
    );
  }
}

/** An AI SDK tool over an entry, whose functions call its owner. */
function toolOf(
  name: string,
  entry: ToolEntry,
  owner: ExtensionHandle,
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
      execute: (input, options) =>
        execute(owner, name, input, call(options), options.abortSignal)
    })
  } as Tool;
}

/**
 * Run a tool through its owner, as an async generator that yields what
 * the tool yields, when it yields it (or its one result), and throws the
 * owner's error text. So whoever runs it sees the same outputs as from
 * the tool itself. A call whose signal is already aborted never starts.
 */
async function* execute(
  owner: ExtensionHandle,
  name: string,
  input: unknown,
  call: {
    id: string;
    session: ThinkSessionId;
    messages: ModelMessage[];
  },
  signal: AbortSignal | undefined
): AsyncGenerator<unknown> {
  signal?.throwIfAborted();
  const outputs: unknown[] = [];
  let streamed = false;
  let wake: (() => void) | undefined;
  const onAbort = () => owner.cancel(call, signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let settled = false;
  const done = owner
    .execute(name, input, call, (output) => {
      streamed = true;
      outputs.push(output);
      wake?.();
    })
    .finally(() => {
      settled = true;
      wake?.();
    });
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
