import {
  Type,
  type AssistantMessage,
  type ImageContent,
  type TextContent,
  type ToolCall,
  type ToolResultMessage
} from "@earendil-works/pi-ai";
import {
  AgentDoc,
  createRegistry,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type Extension as PiExtension,
  type HookRegistration,
  type PromptSection,
  type Registry,
  type RegistrySnapshot,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
  type Wrap
} from "@earendil-works/pi-durable";
import type { Context } from "./context";
import {
  isNativeTool,
  type Extension,
  type ExtensionFeature,
  type ExtensionSession,
  type NativeTool,
  type NativeToolHandle,
  type Tool,
  type ToolContentPart,
  type ToolEntry,
  type ToolResult,
  type UserReply,
  type UserRequest
} from "../extensions/extension";
import {
  ExtensionHost,
  type ExtensionAlreadyInstalled,
  type ExtensionReport,
  type ExtensionSetupFailed,
  type ExtensionSnapshot
} from "../extensions/host";
import {
  formatIssues,
  isJsonObject,
  type JsonObject
} from "../extensions/schema";
import type { KeyValueStore } from "../extensions/storage";
import { resolveSkillSources, skillsFingerprint } from "./skills";

/** pi-durable honours every portable feature. */
const PI_FEATURES: readonly ExtensionFeature[] = [
  "tool",
  "tool.deferred",
  "tool.native.remove",
  "tool.native.update",
  "tool.execute.before",
  "tool.execute.after",
  "tool.ask",
  "instructions",
  "skill",
  "command",
  "event",
  "session.submit",
  "session.note"
];

/** The pi extension every conversation selects by default. */
export const PORTABLE_EXTENSION = "agents.extensions";

/** A deferred tool's own pi extension, which a session selects to offer it. */
function deferredName(tool: string): string {
  return `${PORTABLE_EXTENSION}.deferred/${tool}`;
}

/** The entry kind of `session.note()`. Shown to clients, not the model. */
export const NOTE_ENTRY = "agents.note";

/** What the runtime needs from the harness, once pi is open. */
export type PiExtensionPorts = {
  readonly store: KeyValueStore;
  readonly session: (id: string) => ExtensionSession;
  readonly onReport: (report: ExtensionReport) => void;
};

/**
 * Portable extensions on pi-durable, as `PiHarness` runs them.
 *
 * pi selects extensions per conversation by name. The runtime hands pi a
 * registry view in which exactly one extension is installed,
 * `agents.extensions`, so it is every conversation's default selection. It
 * holds the native extensions' sections, hooks and wraps, and the tools the
 * portable `tool` domain produced: native tools (renamed, re-described or
 * removed by transforms) and portable ones. Each deferred tool is its own
 * extension, resolvable by name but not installed, so a session offers it
 * only once its agent selects it (`session.tools.activate`, or a result's
 * `activate`). That selection lives in pi's agent document, so it is
 * durable, and forks inherit it.
 *
 * The native extensions stay installed in the inner registry, which the
 * factory installs into, so their tasks still resolve. A conversation
 * whose agent selects extensions by an explicit array bypasses the view's
 * default and sees only what it names.
 */
export class PiExtensionRuntime {
  readonly host: ExtensionHost;
  /** What the factory installs native extensions into and opens pi with. */
  readonly registry: Registry;
  readonly #inner = createRegistry();
  readonly #listeners = new Set<() => void>();
  readonly #handles = new WeakMap<NativeToolHandle, ToolRegistration>();
  readonly #skills = skillCache();
  #main: PiExtension = { name: PORTABLE_EXTENSION };
  #deferred = new Map<string, PiExtension>();
  #view:
    | { readonly inner: RegistrySnapshot; readonly view: RegistrySnapshot }
    | undefined;

  /** @param ports - Storage, sessions and reporting. */
  constructor(ports: PiExtensionPorts) {
    this.host = new ExtensionHost({
      harness: "pi",
      features: PI_FEATURES,
      store: ports.store,
      session: ports.session,
      nativeTools: () => this.#nativeTools(),
      onPublish: (snapshot) => this.#install(snapshot),
      onReport: ports.onReport
    });
    this.#inner.subscribe(() => {
      // A native extension changed: the tool domain's base changed with it.
      this.#view = undefined;
      this.#notify();
      void this.host.reload("tool");
    });
    this.registry = {
      snapshot: () => this.#snapshot(),
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      install: (extension) => this.#inner.install(extension),
      uninstall: (extension) => this.#inner.uninstall(extension)
    };
  }

  /**
   * Start every extension, in order.
   *
   * @param extensions - The portable extensions.
   * @returns The ones that failed to start; the rest run.
   */
  async start(
    extensions: readonly Extension[]
  ): Promise<(ExtensionAlreadyInstalled | ExtensionSetupFailed)[]> {
    const failures: (ExtensionAlreadyInstalled | ExtensionSetupFailed)[] = [];
    for (const extension of extensions) {
      const added = await this.host.add(extension);
      if (added._tag === "err") failures.push(added.error);
    }
    await this.host.reload();
    return failures;
  }

  /**
   * Which deferred tools a conversation offers. Edits pi's agent document
   * inside `tx`, so it commits with whatever else the caller commits.
   *
   * @param tx - A pi commit.
   * @param conversationId - The conversation.
   * @param tools - Deferred tool ids.
   * @param offer - Offer them, or stop.
   */
  static async select(
    tx: Tx,
    conversationId: ConversationId,
    tools: readonly string[],
    offer: "offer" | "withdraw"
  ): Promise<void> {
    const agent = await tx.doc(AgentDoc, conversationId);
    const names = tools.map(deferredName);
    const stored = agent.extensions;
    if (Array.isArray(stored)) {
      agent.extensions =
        offer === "offer"
          ? [...new Set([...stored, ...names])]
          : stored.filter((name) => !names.includes(name));
      return;
    }
    const add = stored?.add ?? [];
    const remove = stored?.remove ?? [];
    agent.extensions =
      offer === "offer"
        ? {
            add: [...new Set([...add, ...names])],
            remove: remove.filter((name) => !names.includes(name))
          }
        : { add: add.filter((name) => !names.includes(name)), remove };
  }

  #snapshot(): RegistrySnapshot {
    const inner = this.#inner.snapshot();
    if (this.#view?.inner === inner) return this.#view.view;
    const main = this.#main;
    const deferred = this.#deferred;
    const view: RegistrySnapshot = {
      installed: () => [main],
      extension: (name) =>
        name === main.name
          ? main
          : (deferred.get(name) ?? inner.extension(name)),
      tools: () =>
        (main.tools ?? []).map((tool) => ({ extension: main, tool })),
      sections: () =>
        (main.sections ?? []).map((section) => ({ extension: main, section })),
      tasks: () => inner.tasks(),
      task: (name) => inner.task(name)
    };
    this.#view = { inner, view };
    return view;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Native tools as the draft sees them, composed by name like pi does. */
  #nativeTools(): NativeTool[] {
    const composed = new Map<string, ToolRegistration>();
    for (const extension of this.#inner.snapshot().installed()) {
      for (const tool of extension.tools ?? []) composed.set(tool.name, tool);
    }
    return [...composed.values()].map((tool) => {
      const native: NativeToolHandle = { harness: "pi" };
      this.#handles.set(native, tool);
      return {
        id: tool.name,
        description: tool.description,
        inputSchema: { ...tool.parameters },
        native
      };
    });
  }

  async #install(snapshot: ExtensionSnapshot): Promise<void> {
    const natives = this.#inner.snapshot().installed();
    const skills = await this.#skills(snapshot);
    const offered: ToolRegistration[] = [];
    const deferred = new Map<string, PiExtension>();
    for (const entry of snapshot.tools) {
      const tool = this.#toPi(entry);
      if (!tool) continue;
      if (entry.deferred) {
        const name = deferredName(entry.id);
        deferred.set(name, { name, tools: [tool] });
      } else {
        offered.push(tool);
      }
    }
    const nativeSections: PromptSection[] = natives.flatMap(
      (extension) => extension.sections ?? []
    );
    const nativeHooks: HookRegistration[] = natives.flatMap(
      (extension) => extension.hooks ?? []
    );
    const nativeWraps: Wrap[] = natives.flatMap(
      (extension) => extension.wraps ?? []
    );
    this.#main = {
      name: PORTABLE_EXTENSION,
      tools: [...offered, ...skills.tools],
      sections: [
        ...nativeSections,
        ...snapshot.instructions.map(
          ({ key, text }): PromptSection => ({ key, render: () => text })
        ),
        ...(skills.catalog === null
          ? []
          : [{ key: "skills", render: () => skills.catalog ?? undefined }])
      ],
      hooks: [...nativeHooks, this.#toolHook, this.#generationHook],
      wraps: nativeWraps
    };
    this.#deferred = deferred;
    this.#view = undefined;
    this.#notify();
  }

  #toPi(entry: ToolEntry): ToolRegistration | undefined {
    if (!isNativeTool(entry)) return this.#toPiTool(entry);
    const original = this.#handles.get(entry.native);
    if (!original) return undefined;
    return { ...original, name: entry.id, description: entry.description };
  }

  /** A portable tool as a pi tool registration. */
  #toPiTool(tool: Tool): ToolRegistration {
    const schema = tool.input["~standard"];
    const host = this.host;
    return {
      name: tool.id,
      description: tool.description,
      // pi validates arguments against this before the hooks and again after
      // them; the tool's own schema parses them once more in execute.
      parameters: Type.Unsafe<JsonObject>(
        schema.jsonSchema.input({ target: "draft-07" })
      ),
      replay: tool.replay ?? "unsafe",
      async execute(args, api, context) {
        const parsed = await schema.validate(args);
        if (parsed.issues) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid input: ${formatIssues(parsed.issues)}`
              }
            ],
            isError: true
          };
        }
        let asks = 0;
        const session = String(api.conversationId);
        const result = await tool.execute(parsed.value, {
          session,
          callId: api.callId,
          signal: context.abortSignal ?? new AbortController().signal,
          progress: (text) => api.output(text),
          update: (metadata) => api.details(metadata, context),
          ask: async <R extends UserRequest>(request: R) => {
            if (tool.replay !== "safe") {
              throw new Error(
                `Tool ${tool.id} asks the user, so it must be replay: "safe"`
              );
            }
            const reply = await ask(host, api, context, {
              memo: `agents.ask.${asks++}`,
              session,
              tool: tool.id,
              request
            });
            // SAFETY: RequestStore.reply only stores an answer that fits the
            // request's kind (boolean for confirm, string otherwise), which
            // is exactly UserReply<R>.
            return reply as UserReply<R>;
          }
        });
        if (result.activate && result.activate.length > 0) {
          const ids = result.activate;
          await api.commit(
            (tx) =>
              PiExtensionRuntime.select(tx, api.conversationId, ids, "offer"),
            context
          );
        }
        return toPiResult(result);
      }
    };
  }

  /** Runs the portable tool hooks on every tool call pi makes. */
  readonly #toolHook = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (!this.host.hooks("execute.before")) return undefined;
      const session = String(api.conversationId);
      const event = await this.host.beforeTool({
        tool: call.name,
        session,
        callId: call.id,
        input: portableInput(call.arguments)
      });
      if (event.block !== undefined) return { block: event.block };
      if (event.ask !== undefined) {
        const approved = await ask(this.host, api, context, {
          memo: "agents.ask.before",
          session,
          tool: call.name,
          callId: call.id,
          request: { kind: "confirm", message: event.ask }
        });
        if (approved !== true) {
          return { block: `The user declined: ${event.ask}` };
        }
      }
      return { arguments: event.input };
    },
    afterTool: async (call, result, api) => {
      if (!this.host.hooks("tool.end")) return undefined;
      const original = fromPiResult(result);
      const event = await this.host.afterTool({
        tool: call.name,
        session: String(api.conversationId),
        callId: call.id,
        input: portableInput(call.arguments),
        result: original
      });
      if (event.result === original) return undefined;
      return { ...result, ...toPiResult(event.result) };
    }
  });

  /** Reports model messages and final answers as portable events. */
  readonly #generationHook = hook(GenerationTask, {
    afterResponse: async (message, api) => {
      if (!this.host.hooks("message.end")) return;
      await this.host.emit("message.end", {
        session: String(api.conversationId),
        text: assistantText(message)
      });
    },
    onYield: async (answer, api) => {
      if (!this.host.hooks("turn.end")) return undefined;
      await this.host.emit("turn.end", {
        session: String(api.conversationId),
        text: assistantText(answer)
      });
      return undefined;
    }
  });
}

/**
 * Ask the person, durably. The request id is a memo on the asking task, so
 * after an eviction the rerun finds the same request and its answer.
 */
async function ask(
  host: ExtensionHost,
  api: Pick<ToolExecutionApi, "memo"> & { readonly callId?: string },
  context: Context,
  asked: {
    readonly memo: string;
    readonly session: string;
    readonly tool: string;
    readonly callId?: string;
    readonly request: UserRequest;
  }
) {
  const id = await api.memo<string>(asked.memo, crypto.randomUUID(), context);
  const opened = host.requests.open({
    id,
    session: asked.session,
    tool: asked.tool,
    callId: asked.callId ?? api.callId ?? "",
    request: asked.request,
    askedAt: Date.now()
  });
  if (opened.status === "answered") return opened.reply;
  return host.requests.wait(id, context.abortSignal);
}

/** Resolve skill sources only when their fingerprints change. */
function skillCache() {
  let cached:
    | {
        readonly fingerprint: string;
        readonly value: Awaited<ReturnType<typeof resolveSkillSources>>;
      }
    | undefined;
  return async (snapshot: ExtensionSnapshot) => {
    const fingerprint = skillsFingerprint(snapshot.skills);
    if (cached?.fingerprint !== fingerprint) {
      const value = await resolveSkillSources(snapshot.skills);
      for (const warning of value.warnings) {
        console.warn(`pi skills: ${warning}`);
      }
      cached = { fingerprint, value };
    }
    return cached.value;
  };
}

/** A copy of a call's arguments, for hooks to edit freely. */
function portableInput(args: ToolCall["arguments"]): JsonObject {
  // SAFETY: pi-ai's JsonObject differs from the portable one only in that
  // its arrays are readonly. structuredClone makes a fresh, unshared copy,
  // so handing it out as mutable cannot reach pi's own record.
  return structuredClone(args) as JsonObject;
}

function toPiContent(
  content: ToolResult["content"]
): ToolResultMessage["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): TextContent | ImageContent =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType }
  );
}

function toPiResult(result: ToolResult): ToolExecutionResult {
  return {
    content: toPiContent(result.content),
    isError: result.isError ?? false,
    ...(result.metadata === undefined ? {} : { details: result.metadata })
  };
}

function fromPiResult(result: ToolExecutionResult): ToolResult {
  const content = (result.content ?? []).map(
    (part): ToolContentPart =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType }
  );
  const details: unknown = result.details;
  return {
    content,
    isError: result.isError ?? false,
    ...(isJsonObject(details) ? { metadata: portableInput(details) } : {})
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}
