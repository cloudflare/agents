import type { SkillSource } from "../../skills";
import {
  isNativeTool,
  type Cleanup,
  type Command,
  type CommandDraft,
  type Extension,
  type ExtensionContext,
  type ExtensionFeature,
  type ExtensionSession,
  type HarnessEvents,
  type InstructionsDraft,
  type NativeTool,
  type Registration,
  type SkillDraft,
  type ToolAfterEvent,
  type ToolBeforeEvent,
  type ToolDraft,
  type ToolEntry,
  type ToolHookEvents,
  type TransformDomain
} from "./extension";
import { RequestStore } from "./requests";
import { extensionStorage, type KeyValueStore } from "./storage";

/**
 * Runs portable extensions for one harness. A harness adapter builds one,
 * adds extensions, and turns each published `ExtensionSnapshot` into its
 * native configuration. It runs tool calls through `beforeTool` and
 * `afterTool`, reports what happens with `emit`, and resolves slash
 * commands with `command`.
 *
 * The host owns the replay semantics, so every harness gets the same ones:
 *
 * - A rebuild starts from the domain's base (the harness's native tools for
 *   `tool`, empty for the rest) and runs every transform of the domain
 *   once, in extension order, then registration order.
 * - Rebuilds of a domain are serialized and coalesced: calls during a
 *   rebuild share one more rebuild, which sees every registration made
 *   before it started.
 * - An extension's start is batched: its transforms rebuild once, after it.
 *   Extensions start and stop one at a time.
 * - A transform may not register or dispose anything while it is replaying.
 */
export class ExtensionHost {
  readonly #options: ExtensionHostOptions;
  readonly #features: ReadonlySet<ExtensionFeature>;
  readonly #installed = new Map<Extension, Installed>();
  readonly #tools: ReplayedDomain<Map<string, ToolEntry>, ToolDraft>;
  readonly #instructions: ReplayedDomain<
    Map<string, string>,
    InstructionsDraft
  >;
  readonly #skills: ReplayedDomain<Map<string, SkillSource>, SkillDraft>;
  readonly #commands: ReplayedDomain<Map<string, Command>, CommandDraft>;
  readonly #hooks: {
    readonly [Name in keyof ToolHookEvents]: Handler<ToolHookEvents[Name]>[];
  } = { "execute.before": [], "execute.after": [] };
  readonly #handlers: {
    readonly [Name in keyof HarnessEvents]: Handler<HarnessEvents[Name]>[];
  } = {
    "session.created": [],
    "message.end": [],
    "tool.end": [],
    "turn.end": []
  };
  /** Domains the starting extension touched, rebuilt once when it ends. */
  #batch: Set<AnyDomain> | undefined;
  /** Extensions start and stop one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  #publishing: Promise<void> = Promise.resolve();

  /** Questions for the person using a session; adapters park asks here. */
  readonly requests: RequestStore;

  /**
   * @param options - The harness's name, features and ports, and where
   *   snapshots and failures go.
   */
  constructor(options: ExtensionHostOptions) {
    this.#options = options;
    this.#features = new Set(options.features);
    this.requests = new RequestStore(options.store);
    const replayed = <V, D>(
      domain: DomainName,
      initial: () => V,
      draft: (value: V) => D
    ) =>
      new ReplayedDomain<V, D>(domain, initial, draft, {
        report: (extension, cause) =>
          this.#report({ _tag: "TransformFailed", extension, domain, cause }),
        published: () => this.#publish()
      });
    this.#tools = replayed(
      "tool",
      () =>
        new Map(
          (options.nativeTools?.() ?? []).map((tool): [string, ToolEntry] => [
            tool.id,
            tool
          ])
        ),
      (tools) => toolDraft(tools, this.#features)
    );
    this.#instructions = replayed(
      "instructions",
      () => new Map<string, string>(),
      instructionsDraft
    );
    this.#skills = replayed(
      "skill",
      () => new Map<string, SkillSource>(),
      skillDraft
    );
    this.#commands = replayed(
      "command",
      () => new Map<string, Command>(),
      commandDraft
    );
  }

  /** The current result of every domain. */
  snapshot(): ExtensionSnapshot {
    return {
      tools: [...this.#tools.value().values()],
      instructions: [...this.#instructions.value()].map(([key, text]) => ({
        key,
        text
      })),
      skills: [...this.#skills.value().values()],
      commands: [...this.#commands.value().values()]
    };
  }

  /** The installed extensions, in order. */
  installed(): readonly Extension[] {
    return [...this.#installed.keys()];
  }

  /**
   * Install an extension: run it, then rebuild what it touched. One that
   * throws is rolled back: nothing it registered stays.
   *
   * @param extension - The extension to install.
   * @returns `ok`, or why it was not installed.
   */
  add(extension: Extension): Promise<
    | { readonly _tag: "ok" }
    | {
        readonly _tag: "err";
        readonly error: ExtensionAlreadyInstalled | ExtensionSetupFailed;
      }
  > {
    return this.#serially(async () => {
      const name = labelOf(extension, this.#installed.size);
      if (this.#installed.has(extension)) {
        return {
          _tag: "err" as const,
          error: new ExtensionAlreadyInstalled(name)
        };
      }
      const installed: Installed = {
        name,
        registrations: new Set(),
        cleanup: undefined
      };
      this.#installed.set(extension, installed);
      const batch = new Set<AnyDomain>();
      this.#batch = batch;
      try {
        const cleanup = await extension(this.#context(installed));
        installed.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      } catch (cause) {
        this.#installed.delete(extension);
        for (const registration of [...installed.registrations]) {
          registration.detach(batch);
        }
        return {
          _tag: "err" as const,
          error: new ExtensionSetupFailed(name, cause)
        };
      } finally {
        this.#batch = undefined;
        await this.#flush(batch);
      }
      return { _tag: "ok" as const };
    });
  }

  /**
   * Uninstall an extension: run its cleanup, drop everything it registered,
   * and rebuild what it touched.
   *
   * @param extension - The installed extension.
   * @returns Whether it was installed.
   */
  remove(extension: Extension): Promise<boolean> {
    return this.#serially(async () => {
      const installed = this.#installed.get(extension);
      if (!installed) return false;
      this.#installed.delete(extension);
      const batch = new Set<AnyDomain>();
      for (const registration of [...installed.registrations]) {
        registration.detach(batch);
      }
      try {
        await installed.cleanup?.();
      } catch (cause) {
        this.#report({
          _tag: "CleanupFailed",
          extension: installed.name,
          cause
        });
      }
      await this.#flush(batch);
      return true;
    });
  }

  /**
   * Rebuild one domain, or all of them. An adapter rebuilds `tool` when the
   * harness's native tools change.
   *
   * @param domain - The domain; every domain when omitted.
   */
  async reload(domain?: DomainName): Promise<void> {
    const domains = {
      tool: this.#tools,
      instructions: this.#instructions,
      skill: this.#skills,
      command: this.#commands
    };
    await Promise.all(
      (domain ? [domains[domain]] : Object.values(domains)).map((each) =>
        each.rebuild()
      )
    );
  }

  /**
   * Run the `execute.before` hooks on a call, in order. A hook that throws
   * blocks the call with its message (fail closed). The first block stops
   * the chain. The adapter then asks `event.ask`, if a hook set it.
   *
   * @param event - The call; hooks edit it in place.
   * @returns The same event, edited.
   */
  async beforeTool(event: ToolBeforeEvent): Promise<ToolBeforeEvent> {
    for (const hook of [...this.#hooks["execute.before"]]) {
      if (event.block !== undefined) break;
      try {
        await hook.handler(event);
      } catch (cause) {
        event.block = cause instanceof Error ? cause.message : String(cause);
      }
    }
    return event;
  }

  /**
   * Run the `execute.after` hooks on a result, in order, then the
   * `tool.end` handlers. A hook that throws is reported and skipped; the
   * result stays as earlier hooks left it.
   *
   * @param event - The call and its result; hooks edit it in place.
   * @returns The same event, edited.
   */
  async afterTool(event: ToolAfterEvent): Promise<ToolAfterEvent> {
    for (const hook of [...this.#hooks["execute.after"]]) {
      try {
        await hook.handler(event);
      } catch (cause) {
        this.#report({
          _tag: "HookFailed",
          extension: hook.owner,
          hook: "execute.after",
          cause
        });
      }
    }
    await this.emit("tool.end", {
      session: event.session,
      tool: event.tool,
      callId: event.callId,
      result: event.result
    });
    return event;
  }

  /** Whether anything listens to a tool hook or event; adapters skip work if not. */
  hooks(name: keyof ToolHookEvents | keyof HarnessEvents): boolean {
    if (name === "execute.before" || name === "execute.after") {
      return this.#hooks[name].length > 0;
    }
    return (
      this.#handlers[name].length > 0 ||
      (name === "tool.end" && this.#hooks["execute.after"].length > 0)
    );
  }

  /**
   * Deliver an event to its handlers, in order. A handler that throws is
   * reported and skipped.
   *
   * @param name - The event.
   * @param event - Its payload.
   */
  async emit<Name extends keyof HarnessEvents>(
    name: Name,
    event: HarnessEvents[Name]
  ): Promise<void> {
    const handlers: Handler<HarnessEvents[Name]>[] = this.#handlers[name];
    for (const handler of [...handlers]) {
      try {
        await handler.handler(event);
      } catch (cause) {
        this.#report({
          _tag: "HandlerFailed",
          extension: handler.owner,
          event: name,
          cause
        });
      }
    }
  }

  /**
   * Match `/<name> <args>` against the commands.
   *
   * @param input - What was sent to the session.
   * @returns The command and its arguments, or nothing for a non-command.
   */
  command(
    input: string
  ): { readonly command: Command; readonly args: string } | undefined {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
    const name = match?.[1];
    if (name === undefined) return undefined;
    const command = this.#commands.value().get(name);
    return command ? { command, args: match?.[2]?.trim() ?? "" } : undefined;
  }

  #context(installed: Installed): ExtensionContext {
    const owner = installed.name;
    const requireFeature = (feature: ExtensionFeature) => {
      if (!this.#features.has(feature)) {
        throw new ExtensionFeatureUnsupported(
          owner,
          this.#options.harness,
          feature
        );
      }
    };
    const domain = <V, D>(
      feature: ExtensionFeature,
      replayed: ReplayedDomain<V, D>
    ): TransformDomain<D> => ({
      transform: (edit) => {
        requireFeature(feature);
        return this.#track(installed, replayed.register(owner, edit), replayed);
      },
      reload: () => replayed.rebuild()
    });
    const tools = domain("tool", this.#tools);
    const instructions = domain("instructions", this.#instructions);
    const skills = domain("skill", this.#skills);
    const commands = domain("command", this.#commands);
    return {
      harness: this.#options.harness,
      supports: (feature) => this.#features.has(feature),
      tool: {
        ...tools,
        add: (tool) => tools.transform((draft) => draft.add(tool)),
        hook: (name, handler) => {
          requireFeature(`tool.${name}`);
          const hooks: Handler<ToolHookEvents[typeof name]>[] =
            this.#hooks[name];
          return this.#subscribe(installed, hooks, handler);
        }
      },
      instructions: {
        ...instructions,
        set: (key, text) =>
          instructions.transform((draft) => draft.set(key, text))
      },
      skill: {
        ...skills,
        add: (source) => skills.transform((draft) => draft.add(source))
      },
      command: {
        ...commands,
        add: (command) => commands.transform((draft) => draft.add(command))
      },
      event: {
        on: (name, handler) => {
          requireFeature("event");
          const handlers: Handler<HarnessEvents[typeof name]>[] =
            this.#handlers[name];
          return this.#subscribe(installed, handlers, handler);
        }
      },
      storage: (namespace) => extensionStorage(this.#options.store, namespace),
      session: (id) => this.#session(id, requireFeature)
    };
  }

  #session(
    id: string,
    requireFeature: (feature: ExtensionFeature) => void
  ): ExtensionSession {
    const session = this.#options.session(id);
    return {
      id,
      submit: (input, options) => {
        requireFeature("session.submit");
        return session.submit(input, options);
      },
      note: (text, options) => {
        requireFeature("session.note");
        return session.note(text, options);
      },
      tools: {
        activate: (ids) => {
          requireFeature("tool.deferred");
          return session.tools.activate(ids);
        },
        deactivate: (ids) => {
          requireFeature("tool.deferred");
          return session.tools.deactivate(ids);
        },
        offered: () => session.tools.offered()
      }
    };
  }

  #subscribe<E>(
    installed: Installed,
    list: Handler<E>[],
    handler: (event: E) => void | Promise<void>
  ): Registration {
    const entry = { owner: installed.name, handler };
    list.push(entry);
    return this.#track(installed, () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    });
  }

  /**
   * Record a registration on its extension and return its handle. While
   * the extension starts, the domain joins the batch; later it rebuilds now.
   */
  #track(
    installed: Installed,
    remove: () => void,
    domain?: AnyDomain
  ): Registration {
    let active = true;
    const registration: Tracked = {
      detach: (batch) => {
        if (!active) return;
        active = false;
        installed.registrations.delete(registration);
        remove();
        if (domain) batch.add(domain);
      }
    };
    installed.registrations.add(registration);
    if (domain) {
      if (this.#batch) this.#batch.add(domain);
      else void domain.rebuild();
    }
    return {
      dispose: async () => {
        const batch = new Set<AnyDomain>();
        registration.detach(batch);
        await this.#flush(batch);
      }
    };
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #flush(batch: Set<AnyDomain>): Promise<void> {
    await Promise.all([...batch].map((domain) => domain.rebuild()));
  }

  /** Publish snapshots in order; a later rebuild never publishes first. */
  #publish(): Promise<void> {
    const next = this.#publishing.then(async () => {
      try {
        await this.#options.onPublish(this.snapshot());
      } catch (cause) {
        this.#report({ _tag: "PublishFailed", cause });
      }
    });
    this.#publishing = next;
    return next;
  }

  #report(report: ExtensionReport): void {
    (this.#options.onReport ?? ((each) => console.warn(each)))(report);
  }
}

/** How an adapter configures an `ExtensionHost`. */
export type ExtensionHostOptions = {
  /** The harness's name, as `ExtensionContext.harness`. */
  readonly harness: string;
  /** What this harness can honour. Using anything else fails the extension. */
  readonly features: Iterable<ExtensionFeature>;
  /** Where `ctx.storage` and open requests live. */
  readonly store: KeyValueStore;
  /** The harness's own tools: the base every `tool` rebuild starts from. */
  readonly nativeTools?: () => readonly NativeTool[];
  /** One session of the harness, for `ctx.session`. */
  readonly session: (id: string) => ExtensionSession;
  /** Called after every rebuild with every domain's result. */
  readonly onPublish: (snapshot: ExtensionSnapshot) => void | Promise<void>;
  /** Failures that do not fail the calling operation. */
  readonly onReport?: (report: ExtensionReport) => void;
};

/** Every domain's result, as an adapter turns it into native config. */
export type ExtensionSnapshot = {
  /** Native and portable tools, deferred ones included. */
  readonly tools: readonly ToolEntry[];
  readonly instructions: readonly {
    readonly key: string;
    readonly text: string;
  }[];
  readonly skills: readonly SkillSource[];
  readonly commands: readonly Command[];
};

/** A domain an adapter can rebuild. */
export type DomainName = "tool" | "instructions" | "skill" | "command";

/** A failure the host survived. `extension` is the extension's label. */
export type ExtensionReport =
  | {
      readonly _tag: "TransformFailed";
      readonly extension: string;
      readonly domain: DomainName;
      readonly cause: unknown;
    }
  | {
      readonly _tag: "HookFailed";
      readonly extension: string;
      readonly hook: keyof ToolHookEvents;
      readonly cause: unknown;
    }
  | {
      readonly _tag: "HandlerFailed";
      readonly extension: string;
      readonly event: keyof HarnessEvents;
      readonly cause: unknown;
    }
  | {
      readonly _tag: "CleanupFailed";
      readonly extension: string;
      readonly cause: unknown;
    }
  | { readonly _tag: "PublishFailed"; readonly cause: unknown };

/** This extension is already installed. */
export class ExtensionAlreadyInstalled extends Error {
  readonly _tag = "ExtensionAlreadyInstalled" as const;
  /** @param extension - The extension's label. */
  constructor(readonly extension: string) {
    super(`Extension ${extension} is already installed`);
  }
}

/** An extension threw while starting, so it was rolled back. */
export class ExtensionSetupFailed extends Error {
  readonly _tag = "ExtensionSetupFailed" as const;
  /**
   * @param extension - The extension's label.
   * @param cause - What it threw.
   */
  constructor(
    readonly extension: string,
    override readonly cause: unknown
  ) {
    super(
      `Extension ${extension} failed to start: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
}

/**
 * An extension used a feature this harness cannot honour. Thrown inside the
 * extension, so `add()` returns it as the cause of `ExtensionSetupFailed`
 * when it happens while the extension starts.
 */
export class ExtensionFeatureUnsupported extends Error {
  readonly _tag = "ExtensionFeatureUnsupported" as const;
  /**
   * @param extension - The extension's label.
   * @param harness - The harness's name.
   * @param feature - The feature it does not support.
   */
  constructor(
    readonly extension: string,
    readonly harness: string,
    readonly feature: ExtensionFeature
  ) {
    super(`${harness} does not support ${feature} (extension ${extension})`);
  }
}

/** An extension's name in reports: its function name, or its position. */
function labelOf(extension: Extension, index: number): string {
  return extension.name === "" ? `extension #${index + 1}` : extension.name;
}

type Handler<E> = {
  readonly owner: string;
  readonly handler: (event: E) => void | Promise<void>;
};

type Tracked = { detach(batch: Set<AnyDomain>): void };

type Installed = {
  readonly name: string;
  readonly registrations: Set<Tracked>;
  cleanup: Cleanup | undefined;
};

type AnyDomain = { rebuild(): Promise<void> };

type DomainEvents = {
  readonly report: (extension: string, cause: unknown) => void;
  readonly published: () => Promise<void>;
};

type Transform<D> = {
  readonly owner: string;
  readonly edit: (draft: D) => void | Promise<void>;
};

/**
 * One domain's value and transforms. `register` and the returned remover
 * change only the list; the host decides when to `rebuild`.
 */
class ReplayedDomain<V, D> {
  readonly #name: DomainName;
  readonly #initial: () => V;
  readonly #draft: (value: V) => D;
  readonly #events: DomainEvents;
  #transforms: readonly Transform<D>[] = [];
  #value: V;
  #replaying = false;
  #current: Promise<void> | undefined;
  #queued: Promise<void> | undefined;

  constructor(
    name: DomainName,
    initial: () => V,
    draft: (value: V) => D,
    events: DomainEvents
  ) {
    this.#name = name;
    this.#initial = initial;
    this.#draft = draft;
    this.#events = events;
    this.#value = initial();
  }

  value(): V {
    return this.#value;
  }

  register(owner: string, edit: Transform<D>["edit"]): () => void {
    this.#assertNotReplaying();
    const transform = { owner, edit };
    this.#transforms = [...this.#transforms, transform];
    return () => {
      this.#assertNotReplaying();
      this.#transforms = this.#transforms.filter((each) => each !== transform);
    };
  }

  /** Rebuild after any running rebuild; concurrent calls share one. */
  rebuild(): Promise<void> {
    if (this.#queued) return this.#queued;
    const previous = this.#current ?? Promise.resolve();
    const next: Promise<void> = previous.then(async () => {
      this.#queued = undefined;
      this.#current = next;
      try {
        await this.#materialize();
      } finally {
        if (this.#current === next) this.#current = undefined;
      }
    });
    this.#queued = next;
    return next;
  }

  async #materialize(): Promise<void> {
    const value = this.#initial();
    const draft = this.#draft(value);
    const transforms = this.#transforms;
    this.#replaying = true;
    try {
      for (const transform of transforms) {
        try {
          await transform.edit(draft);
        } catch (cause) {
          this.#events.report(transform.owner, cause);
        }
      }
    } finally {
      this.#replaying = false;
    }
    this.#value = value;
    await this.#events.published();
  }

  #assertNotReplaying(): void {
    if (this.#replaying) {
      throw new Error(
        `Cannot change ${this.#name} registrations while ${this.#name} is rebuilding`
      );
    }
  }
}

function toolDraft(
  tools: Map<string, ToolEntry>,
  features: ReadonlySet<ExtensionFeature>
): ToolDraft {
  const requireFor = (entry: ToolEntry, feature: ExtensionFeature) => {
    if (isNativeTool(entry) && !features.has(feature)) {
      throw new Error(`This harness does not support ${feature}`);
    }
  };
  const requireDeferred = (entry: ToolEntry) => {
    if (entry.deferred && !features.has("tool.deferred")) {
      throw new Error("This harness does not support tool.deferred");
    }
  };
  return {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    add: (tool) => {
      requireDeferred(tool);
      const existing = tools.get(tool.id);
      if (existing) requireFor(existing, "tool.native.update");
      // SAFETY: a Tool<S> is a Tool<ToolInputSchema<unknown>> whose execute
      // takes S's output. The draft stores tools erased; every caller of
      // execute (the adapters) parses input with the tool's own schema first.
      tools.set(tool.id, tool as unknown as ToolEntry);
    },
    update: (id, update) => {
      const entry = tools.get(id);
      if (!entry) return;
      requireFor(entry, "tool.native.update");
      const next = update(entry);
      requireDeferred(next);
      // Same id: keep its place in the order. New id: it moves to the end.
      if (next.id !== id) tools.delete(id);
      tools.set(next.id, next);
    },
    remove: (id) => {
      const entry = tools.get(id);
      if (!entry) return;
      requireFor(entry, "tool.native.remove");
      tools.delete(id);
    }
  };
}

function instructionsDraft(sections: Map<string, string>): InstructionsDraft {
  return {
    list: () => [...sections].map(([key, text]) => ({ key, text })),
    get: (key) => sections.get(key),
    set: (key, text) => {
      sections.set(key, text);
    },
    remove: (key) => {
      sections.delete(key);
    }
  };
}

function skillDraft(sources: Map<string, SkillSource>): SkillDraft {
  return {
    list: () => [...sources.values()],
    add: (source) => {
      sources.set(source.id, source);
    },
    remove: (id) => {
      sources.delete(id);
    }
  };
}

function commandDraft(commands: Map<string, Command>): CommandDraft {
  return {
    list: () => [...commands.values()],
    get: (name) => commands.get(name),
    add: (command) => {
      commands.set(command.name, command);
    },
    remove: (name) => {
      commands.delete(name);
    }
  };
}
