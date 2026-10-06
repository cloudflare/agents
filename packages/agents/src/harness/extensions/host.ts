import type { SkillSource } from "../../skills";
import type {
  Cleanup,
  Extension,
  ExtensionContext,
  ExtensionFeature,
  InstructionsDraft,
  Registration,
  SkillDraft,
  Tool,
  ToolAfterEvent,
  ToolBeforeEvent,
  ToolDraft,
  ToolHookEvents,
  TransformDomain
} from "./extension";

/**
 * Runs portable extensions for one harness. A harness adapter builds one,
 * adds extensions, and turns each published `ExtensionSnapshot` into its
 * native configuration; it runs tool calls through `beforeTool` and
 * `afterTool`.
 *
 * The host owns the replay semantics, so every harness gets the same ones:
 *
 * - A rebuild starts from an empty draft and runs every transform of the
 *   domain once, in extension order, then registration order.
 * - Rebuilds of a domain are serialized and coalesced: calls during a
 *   rebuild share one more rebuild, which sees every registration made
 *   before it started.
 * - An extension's setup is batched: its transforms rebuild once, after it.
 * - A transform may not register or dispose anything while it is replaying.
 */
export class ExtensionHost {
  readonly #harness: string;
  readonly #features: ReadonlySet<ExtensionFeature>;
  readonly #onReport: (error: ExtensionReport) => void;
  readonly #onPublish: (snapshot: ExtensionSnapshot) => void | Promise<void>;
  readonly #installed = new Map<string, Installed>();
  readonly #tools: ReplayedDomain<Map<string, Tool>, ToolDraft>;
  readonly #instructions: ReplayedDomain<
    Map<string, string>,
    InstructionsDraft
  >;
  readonly #skills: ReplayedDomain<Map<string, SkillSource>, SkillDraft>;
  readonly #hooks: {
    readonly [Name in keyof ToolHookEvents]: Hook<ToolHookEvents[Name]>[];
  } = { "execute.before": [], "execute.after": [] };
  /** Domains an in-progress setup touched, rebuilt once when it ends. */
  #batch: Set<AnyDomain> | undefined;
  #publishing: Promise<void> = Promise.resolve();

  /**
   * @param options - The harness's name and features, and where snapshots
   *   and failures go.
   */
  constructor(options: ExtensionHostOptions) {
    this.#harness = options.harness;
    this.#features = new Set(options.features);
    this.#onReport = options.onReport ?? ((report) => console.warn(report));
    this.#onPublish = options.onPublish;
    const replayed = <V, D>(
      domain: DomainName,
      initial: () => V,
      draft: (value: V) => D
    ) =>
      new ReplayedDomain<V, D>(domain, initial, draft, {
        report: (extension, cause) =>
          this.#onReport({ _tag: "TransformFailed", extension, domain, cause }),
        published: () => this.#publish()
      });
    this.#tools = replayed("tool", () => new Map<string, Tool>(), toolDraft);
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
  }

  /** The current result of every domain. */
  snapshot(): ExtensionSnapshot {
    return {
      tools: [...this.#tools.value().values()],
      instructions: [...this.#instructions.value()].map(([key, text]) => ({
        key,
        text
      })),
      skills: [...this.#skills.value().values()]
    };
  }

  /** Ids of the installed extensions, in order. */
  installed(): readonly string[] {
    return [...this.#installed.keys()];
  }

  /**
   * Install an extension: run its setup, then rebuild what it touched.
   * A setup that throws is rolled back: nothing it registered stays.
   *
   * @param extension - The extension to install.
   * @returns `ok`, or why it was not installed.
   */
  async add(extension: Extension): Promise<
    | { readonly _tag: "ok" }
    | {
        readonly _tag: "err";
        readonly error: ExtensionAlreadyInstalled | ExtensionSetupFailed;
      }
  > {
    if (this.#installed.has(extension.id)) {
      return {
        _tag: "err",
        error: new ExtensionAlreadyInstalled(extension.id)
      };
    }
    const installed: Installed = {
      registrations: new Set(),
      cleanup: undefined
    };
    this.#installed.set(extension.id, installed);
    const outer = this.#batch;
    const batch = outer ?? new Set<AnyDomain>();
    this.#batch = batch;
    try {
      const cleanup = await extension.setup(this.#context(extension.id));
      installed.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    } catch (cause) {
      this.#installed.delete(extension.id);
      for (const registration of installed.registrations) {
        registration.detach(batch);
      }
      if (outer === undefined) await this.#flush(batch);
      return {
        _tag: "err",
        error: new ExtensionSetupFailed(extension.id, cause)
      };
    } finally {
      this.#batch = outer;
    }
    if (outer === undefined) await this.#flush(batch);
    return { _tag: "ok" };
  }

  /**
   * Uninstall an extension: run its cleanup, drop everything it registered,
   * and rebuild what it touched.
   *
   * @param id - The extension's id.
   * @returns Whether it was installed.
   */
  async remove(id: string): Promise<boolean> {
    const installed = this.#installed.get(id);
    if (!installed) return false;
    this.#installed.delete(id);
    const batch = new Set<AnyDomain>();
    for (const registration of installed.registrations) {
      registration.detach(batch);
    }
    try {
      await installed.cleanup?.();
    } catch (cause) {
      this.#onReport({ _tag: "CleanupFailed", extension: id, cause });
    }
    await this.#flush(batch);
    return true;
  }

  /** Rebuild every domain, as after a configuration change. */
  async reload(): Promise<void> {
    await Promise.all([
      this.#tools.rebuild(),
      this.#instructions.rebuild(),
      this.#skills.rebuild()
    ]);
  }

  /**
   * Run the `execute.before` hooks on a call, in order. A hook that throws
   * blocks the call with its message (fail closed). The first block stops
   * the chain.
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
   * Run the `execute.after` hooks on a result, in order. A hook that throws
   * is reported and skipped; the result stays as earlier hooks left it.
   *
   * @param event - The call and its result; hooks edit it in place.
   * @returns The same event, edited.
   */
  async afterTool(event: ToolAfterEvent): Promise<ToolAfterEvent> {
    for (const hook of [...this.#hooks["execute.after"]]) {
      try {
        await hook.handler(event);
      } catch (cause) {
        this.#onReport({
          _tag: "HookFailed",
          extension: hook.owner,
          hook: "execute.after",
          cause
        });
      }
    }
    return event;
  }

  /** Whether any extension hooks a tool event; adapters skip work if not. */
  hooks(name: keyof ToolHookEvents): boolean {
    return this.#hooks[name].length > 0;
  }

  #context(owner: string): ExtensionContext {
    const requireFeature = (feature: ExtensionFeature) => {
      if (!this.#installed.has(owner)) {
        throw new Error(`Extension ${owner} is not installed`);
      }
      if (!this.#features.has(feature)) {
        throw new ExtensionFeatureUnsupported(owner, this.#harness, feature);
      }
    };
    const domain = <V, D>(
      feature: ExtensionFeature,
      replayed: ReplayedDomain<V, D>
    ): TransformDomain<D> => ({
      transform: async (edit) => {
        requireFeature(feature);
        return this.#track(owner, replayed.register(owner, edit), replayed);
      },
      reload: () => replayed.rebuild()
    });
    return {
      harness: this.#harness,
      supports: (feature) => this.#features.has(feature),
      tool: {
        ...domain("tool", this.#tools),
        hook: async (name, handler) => {
          requireFeature(`tool.${name}`);
          const hooks: Hook<ToolHookEvents[typeof name]>[] = this.#hooks[name];
          const entry = { owner, handler };
          hooks.push(entry);
          return this.#track(owner, () => {
            const at = hooks.indexOf(entry);
            if (at >= 0) hooks.splice(at, 1);
          });
        }
      },
      instructions: domain("instructions", this.#instructions),
      skill: domain("skill", this.#skills)
    };
  }

  /**
   * Record a registration on its extension and return its handle. Inside a
   * setup the domain joins the batch; outside one it rebuilds now.
   */
  async #track(
    owner: string,
    remove: () => void,
    domain?: AnyDomain
  ): Promise<Registration> {
    const installed = this.#installed.get(owner);
    let active = true;
    const registration: Tracked = {
      detach: (batch) => {
        if (!active) return;
        active = false;
        installed?.registrations.delete(registration);
        remove();
        if (domain) batch.add(domain);
      }
    };
    installed?.registrations.add(registration);
    if (domain) {
      if (this.#batch) this.#batch.add(domain);
      else await domain.rebuild();
    }
    return {
      dispose: async () => {
        const batch = new Set<AnyDomain>();
        registration.detach(batch);
        await this.#flush(batch);
      }
    };
  }

  async #flush(batch: Set<AnyDomain>): Promise<void> {
    await Promise.all([...batch].map((domain) => domain.rebuild()));
  }

  /** Publish snapshots in order; a later rebuild never publishes first. */
  #publish(): Promise<void> {
    const next = this.#publishing.then(async () => {
      try {
        await this.#onPublish(this.snapshot());
      } catch (cause) {
        this.#onReport({ _tag: "PublishFailed", cause });
      }
    });
    this.#publishing = next;
    return next;
  }
}

/** How an adapter configures an `ExtensionHost`. */
export type ExtensionHostOptions = {
  /** The harness's name, as `ExtensionContext.harness`. */
  readonly harness: string;
  /** What this harness can honour. Anything else fails setup. */
  readonly features: Iterable<ExtensionFeature>;
  /** Called after every rebuild with every domain's result. */
  readonly onPublish: (snapshot: ExtensionSnapshot) => void | Promise<void>;
  /** Failures that do not fail the calling operation. */
  readonly onReport?: (report: ExtensionReport) => void;
};

/** Every domain's result, as an adapter turns it into native config. */
export type ExtensionSnapshot = {
  readonly tools: readonly Tool[];
  readonly instructions: readonly {
    readonly key: string;
    readonly text: string;
  }[];
  readonly skills: readonly SkillSource[];
};

type DomainName = "tool" | "instructions" | "skill";

/** A failure the host survived. */
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
      readonly _tag: "CleanupFailed";
      readonly extension: string;
      readonly cause: unknown;
    }
  | { readonly _tag: "PublishFailed"; readonly cause: unknown };

/** An extension with this id is already installed. */
export class ExtensionAlreadyInstalled extends Error {
  readonly _tag = "ExtensionAlreadyInstalled" as const;
  /** @param extension - The duplicate id. */
  constructor(readonly extension: string) {
    super(`Extension ${extension} is already installed`);
  }
}

/** An extension's setup threw, so it was rolled back. */
export class ExtensionSetupFailed extends Error {
  readonly _tag = "ExtensionSetupFailed" as const;
  /**
   * @param extension - The extension's id.
   * @param cause - What setup threw.
   */
  constructor(
    readonly extension: string,
    override readonly cause: unknown
  ) {
    super(
      `Extension ${extension} failed to set up: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
}

/**
 * An extension registered a feature this harness cannot honour. Thrown
 * inside setup, so `add()` returns it as the cause of `ExtensionSetupFailed`.
 */
export class ExtensionFeatureUnsupported extends Error {
  readonly _tag = "ExtensionFeatureUnsupported" as const;
  /**
   * @param extension - The extension's id.
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

type Hook<E> = {
  readonly owner: string;
  readonly handler: (event: E) => void | Promise<void>;
};

type Tracked = { detach(batch: Set<AnyDomain>): void };

type Installed = {
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

function toolDraft(tools: Map<string, Tool>): ToolDraft {
  return {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    add: (tool) => {
      // SAFETY: a Tool<S> is a Tool<ToolInputSchema<unknown>> whose execute
      // takes S's output. The draft stores tools erased; every caller of
      // execute (the adapters) parses input with the tool's own schema first.
      tools.set(tool.id, tool as unknown as Tool);
    },
    update: (id, update) => {
      const tool = tools.get(id);
      if (!tool) return;
      const next = update(tool);
      // Same id: keep its place in the order. New id: it moves to the end.
      if (next.id !== id) tools.delete(id);
      tools.set(next.id, next);
    },
    remove: (id) => {
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
