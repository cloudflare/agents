/**
 * The runtime that sits beside an extension: it runs the extension once,
 * keeps what it registered, hands the harness data, and keeps the
 * functions. The in-process loader is this runtime, called directly; a
 * Worker loader runs the same runtime inside the Worker.
 *
 * @internal Not exported from any entry point.
 */
import type { JSONSchema7 } from "ai";
import type { ThinkSessionId } from "../types";
import type {
  BuildContext,
  Draft,
  Drafts,
  ExtensionHandle,
  ExtensionHookHandler,
  ExtensionHooks,
  ExtensionTool,
  HookHandler,
  HookMap,
  HookRules,
  PromptDraft,
  PromptEntry,
  PromptSection,
  ThinkExtension,
  ToolCall,
  ToolDraft,
  ToolEntry,
  SchemaOf,
  ToolOutcome,
  Transform,
  Validation,
  ToolCaller,
  ToolInvoke
} from "./types";

/**
 * Fields of an AI SDK tool that are functions or schemas, not data. The
 * runtime keeps the ones it can call and drops the rest.
 */
const KEPT = new Set([
  "execute",
  "needsApproval",
  "toModelOutput",
  "description",
  "inputSchema",
  "outputSchema",
  "contextSchema"
]);

/**
 * Called by the AI SDK while the model streams a call's input. Not in the
 * extension API: a callback per delta is the wrong cost across RPC.
 */
const STREAMING = ["onInputStart", "onInputDelta", "onInputAvailable"];

/** A named, ordered collection; setting a name present keeps its place. */
class EntryDraft<Value, Entry> implements Draft<Value, Entry> {
  readonly entries: Map<string, Entry>;

  constructor(
    entries: Iterable<readonly [string, Entry]>,
    readonly onSet: (name: string, value: Value) => Entry,
    readonly onDelete: (name: string) => void
  ) {
    this.entries = new Map(entries);
  }

  get(name: string): Entry | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  set(name: string, value: Value): void {
    this.entries.set(name, this.onSet(name, value));
  }

  delete(name: string): boolean {
    this.onDelete(name);
    return this.entries.delete(name);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }
}

/** A tool draft: also sets who may call a tool another extension set. */
class ToolEntryDraft
  extends EntryDraft<ExtensionTool, ToolEntry>
  implements ToolDraft
{
  setCallers(name: string, callers: readonly ToolCaller[]): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    // The same entry, changed in place: a schema still resolving for it
    // lands on this object, not on a copy the draft no longer holds.
    Object.assign(entry, {
      definition: { ...entry.definition, callers: [...callers] }
    });
    return true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAsyncGeneratorFunction(value: unknown): boolean {
  return (
    typeof value === "function" &&
    value.constructor?.name === "AsyncGeneratorFunction"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function runningKey(call: Pick<ToolCall, "id" | "session">): string {
  return JSON.stringify([call.session, call.id]);
}

/** A tool's entry, with its JSON Schema still to come if it is async. */
type Converted = {
  readonly entry: { -readonly [K in keyof ToolEntry]: ToolEntry[K] };
  readonly schema?: PromiseLike<JSONSchema7>;
  readonly outputSchema?: PromiseLike<JSONSchema7>;
};

/**
 * The runtime beside one extension, for the hooks of `M`. It imports
 * nothing from the AI SDK, so the same code runs in a dynamic Worker.
 *
 * @internal
 */
export class ExtensionRuntime<
  M extends HookMap = ExtensionHooks
> implements ExtensionHandle<M> {
  readonly #name: string;
  readonly #rules: HookRules<M>;
  readonly #schemaOf: SchemaOf;
  readonly #toolTransforms: Transform<ToolDraft>[] = [];
  readonly #promptTransforms: Transform<PromptDraft>[] = [];
  readonly #hooks = new Map<
    keyof M & string,
    HookHandler<unknown, unknown>[]
  >();
  /**
   * The tools this extension set for each session, the latest of each
   * name. One entry per session built in this isolate.
   */
  readonly #kept = new Map<ThinkSessionId, Map<string, ExtensionTool>>();
  /** Converted once per tool object. */
  readonly #converted = new WeakMap<ExtensionTool, Converted>();
  /**
   * Calls running now, to cancel, by session and call id: a provider's
   * call ids are unique only within one model reply.
   */
  readonly #running = new Map<string, AbortController>();

  constructor(name: string, rules: HookRules<M>, schemaOf: SchemaOf) {
    this.#name = name;
    this.#rules = rules;
    this.#schemaOf = schemaOf;
  }

  async install(extension: ThinkExtension<M>): Promise<void> {
    let open = true;
    const registering = (what: string) => {
      if (!open) {
        throw new Error(
          `Extension "${this.#name}" registered ${what} after it returned`
        );
      }
    };
    try {
      await extension({
        name: this.#name,
        tools: {
          transform: (change) => {
            registering("a tool transform");
            this.#toolTransforms.push(change);
          }
        },
        prompt: {
          transform: (change) => {
            registering("a prompt transform");
            this.#promptTransforms.push(change);
          }
        },
        on: <H extends keyof M & string>(
          hook: H,
          handler: ExtensionHookHandler<H, M>
        ) => {
          registering(`a ${hook} hook`);
          const runners = this.#hooks.get(hook) ?? [];
          // SAFETY: the list for `hook` holds only handlers of `hook`, and
          // each is called with a context of `hook`.
          const run = handler as (context: unknown) => unknown;
          runners.push(
            Object.assign(async (context: unknown) => run(context), {
              extension: this.#name
            })
          );
          this.#hooks.set(hook, runners);
        }
      });
    } finally {
      open = false;
    }
  }

  async describe() {
    return { hooks: [...this.#hooks.keys()] };
  }

  async build(drafts: Drafts, build: BuildContext): Promise<Drafts> {
    const kept = new Map<string, ExtensionTool>();
    const pending: PromiseLike<unknown>[] = [];
    const tools = new ToolEntryDraft(
      drafts.tools,
      (toolName, tool) => {
        kept.set(toolName, tool);
        const converted = this.#convert(tool);
        // This name's own entry: the conversion is cached by tool, and two
        // names may share one tool but not their callers.
        const entry = {
          ...converted.entry,
          definition: { ...converted.entry.definition }
        };
        if (converted.schema) {
          pending.push(
            converted.schema.then((schema) => {
              entry.inputSchema = schema;
            })
          );
        }
        if (converted.outputSchema) {
          pending.push(
            converted.outputSchema.then(
              (schema) => {
                entry.outputSchema = schema;
              },
              (error: unknown) => this.#warnOutputSchema(toolName, error)
            )
          );
        }
        return entry;
      },
      (toolName) => kept.delete(toolName)
    );
    const prompt = new EntryDraft<PromptSection, PromptEntry>(
      drafts.prompt,
      (_key, section) => ({ ...section, owner: this.#name }),
      () => {}
    );
    for (const change of this.#toolTransforms) await change(tools, build);
    for (const change of this.#promptTransforms) await change(prompt, build);
    await Promise.all(pending);
    // Tools an earlier build set stay callable: a turn runs on the build it
    // started with even when another build (a watch, the next turn) has
    // dropped one. Bounded by the tool names this extension ever set for
    // the session.
    const known = this.#kept.get(build.session);
    if (known) for (const [toolName, tool] of kept) known.set(toolName, tool);
    else this.#kept.set(build.session, kept);
    return { tools: [...tools.entries], prompt: [...prompt.entries] };
  }

  /** A tool's entry: its data, and which of its functions this side keeps. */
  #convert(tool: ExtensionTool): Converted {
    const cached = this.#converted.get(tool);
    if (cached) return cached;
    const definition: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(tool)) {
      if (KEPT.has(field) || value === undefined) continue;
      if (typeof value === "function") {
        if (STREAMING.includes(field)) {
          console.warn(
            `Extension "${this.#name}": a tool's ${field} is not called; callbacks while the model streams a call's input are not supported`
          );
        }
        continue;
      }
      definition[field] = value;
    }
    // Resolved as the AI SDK does when the call has no tool context.
    const description =
      typeof tool.description === "function"
        ? tool.description({ context: undefined })
        : tool.description;
    if (description !== undefined) definition.description = description;
    const schema = this.#schemaOf(tool.inputSchema);
    const json = schema.jsonSchema;
    const isAsync = typeof (json as PromiseLike<unknown>).then === "function";
    const needsApproval = tool.needsApproval;
    // An output schema is data a hook may read (Think's `beforeTurn` sees
    // the tools whole); it is converted as the input schema is.
    // Not every schema has a JSON Schema (a zod `date()` or `bigint()` has
    // none), and nothing the model is sent needs this one, so a schema
    // that cannot convert is left out rather than failing the build.
    const output = this.#outputSchemaOf(tool.outputSchema);
    const outputIsAsync =
      output !== undefined &&
      typeof (output as PromiseLike<unknown>).then === "function";
    const converted: Converted = {
      entry: {
        owner: this.#name,
        definition,
        // SAFETY: replaced by the resolved schema before the build returns.
        inputSchema: isAsync ? {} : (json as JSONSchema7),
        ...(output !== undefined &&
          !outputIsAsync && { outputSchema: output as JSONSchema7 }),
        execute: typeof tool.execute === "function",
        validate: schema.validate !== undefined,
        modelOutput: typeof tool.toModelOutput === "function",
        streams: isAsyncGeneratorFunction(tool.execute),
        ...(needsApproval === true && { approval: "always" as const }),
        ...(typeof needsApproval === "function" && {
          approval: "call" as const
        })
      },
      ...(isAsync && { schema: json as PromiseLike<JSONSchema7> }),
      ...(outputIsAsync && {
        outputSchema: output as PromiseLike<JSONSchema7>
      })
    };
    this.#converted.set(tool, converted);
    return converted;
  }

  #outputSchemaOf(
    schema: unknown
  ): JSONSchema7 | PromiseLike<JSONSchema7> | undefined {
    if (schema === undefined) return undefined;
    try {
      return this.#schemaOf(schema).jsonSchema;
    } catch (error) {
      this.#warnOutputSchema(undefined, error);
      return undefined;
    }
  }

  #warnOutputSchema(tool: string | undefined, error: unknown): void {
    console.warn(
      `Extension "${this.#name}": ${tool ? `tool "${tool}"'s` : "a tool's"} output schema has no JSON Schema, so it is left out`,
      error
    );
  }

  /**
   * A tool this extension set for `session`. A runtime that has not built
   * for the session (it restarted since, as a Worker may on its own)
   * builds its own tools again first.
   */
  async #toolFor(
    session: ThinkSessionId,
    name: string
  ): Promise<ExtensionTool> {
    if (!this.#kept.has(session)) {
      await this.build({ tools: [], prompt: [] }, { session });
    }
    return this.#tool(session, name);
  }

  #tool(session: ThinkSessionId, name: string): ExtensionTool {
    const tool = this.#kept.get(session)?.get(name);
    if (!tool) {
      throw new Error(
        `Extension "${this.#name}" has no tool "${name}" for this session`
      );
    }
    return tool;
  }

  async execute(
    name: string,
    input: unknown,
    call: ToolCall,
    onOutput: (output: unknown) => void | Promise<void>,
    invoke?: ToolInvoke
  ): Promise<ToolOutcome> {
    const execute = (await this.#toolFor(call.session, name)).execute;
    if (typeof execute !== "function") {
      return { ok: false, errorText: "The tool has no execute function" };
    }
    const controller = new AbortController();
    const key = runningKey(call);
    this.#running.set(key, controller);
    try {
      const result: unknown = await execute(input, {
        toolCallId: call.id,
        messages: call.messages,
        abortSignal: controller.signal,
        context: undefined,
        ...(invoke && { invoke })
      } as Parameters<typeof execute>[1]);
      if (!isAsyncIterable(result)) return { ok: true, output: result };
      let last: unknown;
      for await (const output of result) {
        await onOutput(output);
        last = output;
      }
      return { ok: true, output: last };
    } catch (error) {
      return { ok: false, errorText: errorText(error) };
    } finally {
      if (this.#running.get(key) === controller) this.#running.delete(key);
    }
  }

  cancel(call: Pick<ToolCall, "id" | "session">, reason?: unknown): void {
    this.#running.get(runningKey(call))?.abort(reason);
  }

  async validate(
    name: string,
    input: unknown,
    build: BuildContext
  ): Promise<Validation> {
    const validate = this.#schemaOf(
      (await this.#toolFor(build.session, name)).inputSchema
    ).validate;
    if (!validate) return { success: true, value: input };
    return validate(input);
  }

  async modelOutput(
    name: string,
    output: { toolCallId: string; input: unknown; output: unknown },
    build: BuildContext
  ): Promise<unknown> {
    const toModelOutput = (await this.#toolFor(build.session, name))
      .toModelOutput;
    if (!toModelOutput) {
      throw new Error(`Tool "${name}" has no toModelOutput`);
    }
    return toModelOutput(output);
  }

  async needsApproval(
    name: string,
    input: unknown,
    call: ToolCall
  ): Promise<boolean> {
    const needsApproval = (await this.#toolFor(call.session, name))
      .needsApproval;
    if (typeof needsApproval === "function") {
      return Boolean(
        await needsApproval(input, {
          toolCallId: call.id,
          messages: call.messages,
          context: undefined
        })
      );
    }
    return needsApproval === true;
  }

  async hook<H extends keyof M & string>(
    name: H,
    context: M[H][0]
  ): Promise<M[H][1]> {
    const rule = this.#rules[name];
    // SAFETY: the handlers of hook `name` take and return its types.
    const handlers = (this.#hooks.get(name) ?? []) as unknown as Parameters<
      typeof rule
    >[1];
    return rule(context, handlers);
  }
}
