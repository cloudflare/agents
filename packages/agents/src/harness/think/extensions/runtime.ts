/**
 * The runtime that sits beside an extension: it runs the extension once,
 * keeps what it registered, hands the harness data, and keeps the
 * functions. The in-process loader is this runtime, called directly; a
 * Worker loader runs the same runtime inside the Worker.
 *
 * @internal Not exported from any entry point.
 */
import { asSchema, type JSONSchema7 } from "ai";
import type { ThinkSessionId } from "../types";
import { dispatchHook, type HookRunner } from "./hooks";
import type {
  BuildContext,
  Draft,
  Drafts,
  ExtensionHandle,
  ExtensionHookHandler,
  ExtensionHookName,
  ExtensionHooks,
  ExtensionTool,
  PromptDraft,
  PromptEntry,
  ThinkExtension,
  ToolCall,
  ToolDraft,
  ToolEntry,
  ToolOutcome,
  Transform,
  Validation
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

/** A tool's entry, with its JSON Schema still to come if it is async. */
type Converted = {
  readonly entry: { -readonly [K in keyof ToolEntry]: ToolEntry[K] };
  readonly schema?: PromiseLike<JSONSchema7>;
};

/**
 * Load `extension` in this isolate: run it once, and return its handle.
 *
 * @internal
 */
export async function loadInProcess(
  name: string,
  extension: ThinkExtension
): Promise<ExtensionHandle> {
  const runtime = new ExtensionRuntime(name);
  await runtime.install(extension);
  return runtime;
}

class ExtensionRuntime implements ExtensionHandle {
  readonly #name: string;
  readonly #toolTransforms: Transform<ToolDraft>[] = [];
  readonly #promptTransforms: Transform<PromptDraft>[] = [];
  readonly #hooks = new Map<ExtensionHookName, HookRunner[]>();
  /**
   * The tools this extension set in its latest build for each session,
   * replaced by the next. One entry per session built in this isolate.
   */
  readonly #kept = new Map<ThinkSessionId, Map<string, ExtensionTool>>();
  /** Converted once per tool object. */
  readonly #converted = new WeakMap<ExtensionTool, Converted>();
  /** Calls running now, by call id, to cancel. */
  readonly #running = new Map<string, AbortController>();

  constructor(name: string) {
    this.#name = name;
  }

  async install(extension: ThinkExtension): Promise<void> {
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
        on: <H extends ExtensionHookName>(
          hook: H,
          handler: ExtensionHookHandler<H>
        ) => {
          registering(`a ${hook} hook`);
          const runners = this.#hooks.get(hook) ?? [];
          // SAFETY: the runner list for `hook` holds only handlers of `hook`.
          runners.push(handler as HookRunner);
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
    const tools = new EntryDraft<ExtensionTool, ToolEntry>(
      drafts.tools,
      (toolName, tool) => {
        kept.set(toolName, tool);
        const converted = this.#convert(tool);
        if (converted.schema) {
          pending.push(
            converted.schema.then((schema) => {
              converted.entry.inputSchema = schema;
            })
          );
        }
        return converted.entry;
      },
      (toolName) => kept.delete(toolName)
    );
    const prompt = new EntryDraft<{ readonly text: string }, PromptEntry>(
      drafts.prompt,
      (_key, section) => ({ owner: this.#name, text: section.text }),
      () => {}
    );
    for (const change of this.#toolTransforms) await change(tools, build);
    for (const change of this.#promptTransforms) await change(prompt, build);
    await Promise.all(pending);
    this.#kept.set(build.session, kept);
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
    const schema = asSchema(tool.inputSchema);
    const json = schema.jsonSchema;
    const isAsync = typeof (json as PromiseLike<unknown>).then === "function";
    const needsApproval = tool.needsApproval;
    const converted: Converted = {
      entry: {
        owner: this.#name,
        definition,
        // SAFETY: replaced by the resolved schema before the build returns.
        inputSchema: isAsync ? {} : (json as JSONSchema7),
        execute: typeof tool.execute === "function",
        validate: schema.validate !== undefined,
        modelOutput: typeof tool.toModelOutput === "function",
        ...(needsApproval === true && { approval: "always" as const }),
        ...(typeof needsApproval === "function" && {
          approval: "call" as const
        })
      },
      ...(isAsync && { schema: json as PromiseLike<JSONSchema7> })
    };
    this.#converted.set(tool, converted);
    return converted;
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
    onPreliminary: (output: unknown) => void
  ): Promise<ToolOutcome> {
    const execute = this.#tool(call.session, name).execute;
    if (typeof execute !== "function") {
      return { ok: false, errorText: "The tool has no execute function" };
    }
    const controller = new AbortController();
    this.#running.set(call.id, controller);
    try {
      const result: unknown = await execute(input, {
        toolCallId: call.id,
        messages: call.messages,
        abortSignal: controller.signal,
        context: undefined
      });
      if (!isAsyncIterable(result)) return { ok: true, output: result };
      // A streaming tool's outputs before its last are preliminary.
      let last: unknown;
      let seen = false;
      for await (const output of result) {
        if (seen) onPreliminary(last);
        last = output;
        seen = true;
      }
      return { ok: true, output: last };
    } catch (error) {
      return { ok: false, errorText: errorText(error) };
    } finally {
      if (this.#running.get(call.id) === controller) {
        this.#running.delete(call.id);
      }
    }
  }

  cancel(callId: string, reason?: unknown): void {
    this.#running.get(callId)?.abort(reason);
  }

  async validate(
    name: string,
    input: unknown,
    build: BuildContext
  ): Promise<Validation> {
    const validate = asSchema(
      this.#tool(build.session, name).inputSchema
    ).validate;
    if (!validate) return { success: true, value: input };
    return validate(input);
  }

  async modelOutput(
    name: string,
    output: { toolCallId: string; input: unknown; output: unknown },
    build: BuildContext
  ): Promise<unknown> {
    const toModelOutput = this.#tool(build.session, name).toModelOutput;
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
    const needsApproval = this.#tool(call.session, name).needsApproval;
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

  async hook<H extends ExtensionHookName>(
    name: H,
    context: ExtensionHooks[H][0]
  ): Promise<ExtensionHooks[H][1]> {
    return dispatchHook(name, context, this.#hooks.get(name) ?? []);
  }
}
