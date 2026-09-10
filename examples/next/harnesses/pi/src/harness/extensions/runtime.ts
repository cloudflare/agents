import {
  BACKGROUND_CONTEXT,
  type AgentHarnessTool,
  type AgentHarnessToolInvocation,
  type AgentLane,
  type Context,
  type HarnessEvent,
  type Hooks
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { createEventBus } from "../../../vendor/pi-coding-agent-src/core/event-bus.ts";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
  type Shell
} from "../../../vendor/pi-coding-agent-src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../vendor/pi-coding-agent-src/core/extensions/runner.ts";
import type {
  Extension,
  ExtensionUIContext,
  InputEventResult,
  InputSource,
  RegisteredCommand,
  ToolInfo
} from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { SlashCommandInfo } from "../../../vendor/pi-coding-agent-src/core/slash-commands.ts";
import type { PiModelRegistry } from "../../providers/models";
import type {
  PiExtension,
  PiPromptTemplate,
  PiSkill,
  PiSlashCommand
} from "../types";
import { createExtensionActions } from "./actions";
import { piSlashCommands, slashCommandInfos } from "./commands";
import {
  createExtensionCommandContextActions,
  createExtensionContextActions,
  type ExtensionContextActionDeps
} from "./context-actions";
import { ExtensionEventAdapter } from "./events-adapter";
import { bindExtensionHooks } from "./hooks-adapter";
import { createExtensionModelRegistry } from "./model-registry";
import {
  createResourceLoader,
  extensionPathMetadata,
  type ResourceLoader
} from "./resource-loader";
import { createSessionView } from "./session-view";
import {
  ExtensionLaneStates,
  type ExtensionLaneState,
  type PiExtensionErrorReporter,
  type PiExtensionHandlerError
} from "./state";
import { adaptExtensionTools } from "./tools";

/** Everything the extension runtime needs from the harness that hosts it. */
export type PiExtensionRuntimeDeps = {
  readonly extensions: readonly PiExtension[];
  readonly cwd: string;
  readonly defaultLane: string;
  readonly sessionId: string;
  readonly models: PiModelRegistry;
  /** Initial flag values, overriding the defaults extensions register. */
  readonly flags?: Readonly<Record<string, boolean | string>>;
  /**
   * Prompt templates offered alongside extension commands, as the harness
   * resolved them. A thunk like {@link PiExtensionRuntimeDeps.skills}: the
   * set is not final when the runtime is built, and a configured resource
   * loader can add to it.
   */
  readonly promptTemplates?: () => readonly PiPromptTemplate[];
  /** Skills invocable by name, as the harness resolved them. */
  readonly skills?: () => readonly PiSkill[];
  /** The harness's system prompt, when the configuration fixed one. */
  readonly systemPrompt?: string;
  /**
   * The system prompt the harness would send for one lane right now.
   *
   * `before_agent_start` runs before the harness assembles the prompt, so
   * the cached read model still holds the previous run's prompt — an empty
   * string on the very first run. A harness that can compute its own prompt
   * ahead of the request supplies it here; without one the adapter falls
   * back to the cached value and then to the configured prompt.
   */
  readonly resolveSystemPrompt?: (lane: string) => Promise<string>;
  /**
   * The lane one tool invocation belongs to.
   *
   * `AgentHarnessToolInvocation` carries no lane of its own, so only the
   * harness can map an invocation — recovered ones included — onto the lane
   * whose operation made the call. Without it extension tools run on the
   * default lane.
   */
  readonly laneForInvocation?: (
    invocation: AgentHarnessToolInvocation
  ) => string | undefined;
  /** Resource surface served to pi, replacing the in-memory default. */
  readonly resourceLoader?: ResourceLoader;
  /** Command runner behind `pi.exec`, when the harness has one. */
  readonly shell?: Shell;
  /** Resolve one lane of the attached harness. */
  readonly lane: (name: string) => Promise<AgentLane>;
  /**
   * Submissions the harness has accepted for one lane but the lane driver
   * has not yet admitted into pi. They are invisible in pi's own snapshot,
   * so without this a prompt queued behind a running operation would make
   * `ctx.hasPendingMessages()` answer false.
   */
  readonly pendingSubmissions?: (lane: string) => number;
  /** Rename the session. */
  readonly setSessionName: (name: string) => Promise<void>;
  /** Label one transcript entry. */
  readonly setLabel: (
    entryId: string,
    label: string | undefined
  ) => Promise<void>;
  /** Re-resolve the process-local tool registry after a registration change. */
  readonly refreshTools: () => void;
  /**
   * Republish the slash commands after an extension registered or withdrew
   * one. Unlike tools, commands have no registration callback in pi's
   * extension API, so this fires from the `Extension` record itself.
   */
  readonly commandsChanged?: () => void;
  /** Every tool currently offered to the model. */
  readonly allTools: () => readonly ToolInfo[];
  /** Durably submit one compaction. */
  readonly compact: ExtensionContextActionDeps["compact"];
  /** Durably submit one tree navigation. */
  readonly navigate: ExtensionContextActionDeps["navigate"];
  /** Report a handler failure onto the lane's event stream. */
  readonly report: PiExtensionErrorReporter;
  /**
   * The blocking UI surface `ctx.ui` exposes, when the host has one. With a
   * context the runner runs in `"rpc"` mode and `ctx.hasUI` is true, which
   * says a UI *bridge* exists — not that a client is subscribed to it. The
   * bridge answers that question for itself: a dialog with no subscriber
   * throws rather than inventing an answer nobody gave.
   */
  readonly uiContext?: ExtensionUIContext;
};

function quoted(name: string): string {
  return JSON.stringify(name);
}

/**
 * A `Map` that reports every change it takes.
 *
 * Nothing is reported during construction: the map is created empty and
 * filled through {@link ObservedMap.observe}, because `Map`'s own
 * constructor would call `set` before the change callback exists.
 */
class ObservedMap<K, V> extends Map<K, V> {
  #onChange: (() => void) | undefined;

  /** Adopt `entries` silently, then report every later change. */
  observe(entries: Iterable<readonly [K, V]>, onChange: () => void): this {
    for (const [key, value] of entries) super.set(key, value);
    this.#onChange = onChange;
    return this;
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    this.#onChange?.();
    return this;
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key);
    if (deleted) this.#onChange?.();
    return deleted;
  }

  override clear(): void {
    const had = this.size > 0;
    super.clear();
    if (had) this.#onChange?.();
  }
}

/**
 * Report a loaded extension's later command registrations.
 *
 * `pi.registerCommand` writes straight into the `Extension` record's plain
 * `commands` map (vendored `core/extensions/loader.ts`), and pi's extension
 * API has no registration callback for commands the way it has
 * `runtime.refreshTools()` for tools. An extension that registers one from a
 * `session_start` handler — after the harness published the command set the
 * attachment offers — would leave every connected client's autocomplete a
 * command short until something else republished. Swapping the map for an
 * observed one is the only interception point that does not mean editing the
 * vendored loader.
 */
function observeCommands(extension: Extension, onChange: () => void): void {
  extension.commands = new ObservedMap<string, RegisteredCommand>().observe(
    extension.commands,
    onChange
  );
}

function extensionName(extension: PiExtension, index: number): string {
  return typeof extension === "function"
    ? `<inline:${index}>`
    : `<extension:${extension.name}>`;
}

/**
 * Pi's extension runtime, hosted beside the durable harness.
 *
 * Extensions are process-local: the runtime is rebuilt on every isolate wake
 * from the same configuration, in pi's own order — runtime, event bus, then
 * each extension's registration pass, then the runner. Tools registered
 * during that pass are available before `AgentHarness.create`, which is what
 * lets an extension tool be offered to the model on the very first turn after
 * an eviction. Everything that reaches back into the session — actions,
 * hooks, events — is bound after the harness exists.
 */
export class PiExtensionRuntime {
  readonly #runner: ExtensionRunner;
  readonly #states: ExtensionLaneStates;
  readonly #deps: PiExtensionRuntimeDeps;
  readonly #events: ExtensionEventAdapter;
  readonly #eventBus: ReturnType<typeof createEventBus>;
  readonly #resourcesFactory: () => ResourceLoader;
  #resources: ResourceLoader | undefined;
  #unbindHooks: (() => void) | undefined;
  #stopped = false;

  private constructor(
    runner: ExtensionRunner,
    states: ExtensionLaneStates,
    eventBus: ReturnType<typeof createEventBus>,
    resources: () => ResourceLoader,
    deps: PiExtensionRuntimeDeps
  ) {
    this.#runner = runner;
    this.#states = states;
    this.#eventBus = eventBus;
    this.#resourcesFactory = resources;
    this.#deps = deps;
    this.#events = new ExtensionEventAdapter(runner, {
      states,
      cwd: deps.cwd,
      resolveModel: (provider, modelId) =>
        // SAFETY: the registry returns pi-ai catalog models; PiModel is the
        // narrow public projection of the same object.
        deps.models.getModel(provider, modelId) as Model<Api> | undefined,
      report: deps.report,
      refresh: (lane) => this.#refresh(lane),
      // Discovered paths cannot be read here; the loader records each one as
      // a warning rather than dropping it silently.
      resources: (discovered) => {
        this.resourceLoader.extendResources({
          skillPaths: discovered.skillPaths.map((entry) => ({
            path: entry.path,
            metadata: extensionPathMetadata(entry.extensionPath)
          })),
          promptPaths: discovered.promptPaths.map((entry) => ({
            path: entry.path,
            metadata: extensionPathMetadata(entry.extensionPath)
          })),
          themePaths: discovered.themePaths.map((entry) => ({
            path: entry.path,
            metadata: extensionPathMetadata(entry.extensionPath)
          }))
        });
      }
    });
  }

  /**
   * Load every configured extension and build the runner.
   *
   * Registration runs against action stubs that throw, exactly as upstream
   * does: an extension may register tools, commands, flags and handlers here,
   * but may not act on a session that does not exist yet. A factory that
   * throws is reported and skipped; the rest still load.
   */
  static async create(
    deps: PiExtensionRuntimeDeps
  ): Promise<PiExtensionRuntime> {
    const runtime = createExtensionRuntime();
    const eventBus = createEventBus();
    const loaded: Extension[] = [];
    const errors: { path: string; error: string }[] = [];
    // One broadcast per microtask: a handler that registers several commands
    // in a row publishes the finished set, not each intermediate one.
    let publishing = false;
    const notifyCommandsChanged = (): void => {
      if (publishing || deps.commandsChanged === undefined) return;
      publishing = true;
      queueMicrotask(() => {
        publishing = false;
        deps.commandsChanged?.();
      });
    };
    for (const [index, extension] of deps.extensions.entries()) {
      const path = extensionName(extension, index);
      const factory =
        typeof extension === "function" ? extension : extension.factory;
      try {
        const created = await loadExtensionFromFactory(
          factory,
          deps.cwd,
          eventBus,
          runtime,
          path,
          deps.shell
        );
        if (typeof extension !== "function" && extension.hidden) {
          created.hidden = true;
        }
        observeCommands(created, notifyCommandsChanged);
        loaded.push(created);
      } catch (error) {
        errors.push({
          path,
          error: error instanceof Error ? error.message : String(error)
        });
        deps.report({
          lane: deps.defaultLane,
          kind: "extension",
          source: path,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined
            ? { stack: error.stack }
            : {})
        });
      }
    }

    const states = new ExtensionLaneStates(deps.defaultLane);
    const runner = new ExtensionRunner(
      loaded,
      runtime,
      deps.cwd,
      createSessionView(states, { cwd: deps.cwd, sessionId: deps.sessionId }),
      createExtensionModelRegistry(deps.models)
    );
    // Configured values win over the defaults registered above, so long as
    // an extension registered the flag with that type. One bad entry is
    // reported and skipped rather than failing the whole attachment.
    const registered = runner.getFlags();
    for (const [name, value] of Object.entries(deps.flags ?? {})) {
      const flag = registered.get(name);
      const problem = !flag
        ? `no extension registered a flag named ${quoted(name)}`
        : typeof value !== flag.type
          ? `flag ${quoted(name)} is a ${flag.type} flag, but the configured value is a ${typeof value}`
          : undefined;
      if (problem !== undefined) {
        deps.report({
          lane: deps.defaultLane,
          kind: "extension",
          source: `flag:${name}`,
          message: problem
        });
        continue;
      }
      runner.setFlagValue(name, value);
    }
    // Built on first read, not here: skills and templates are resolved by the
    // harness after the registration pass this method runs.
    const resources = (): ResourceLoader =>
      deps.resourceLoader ??
      createResourceLoader({
        extensions: { extensions: loaded, errors, runtime },
        skills: deps.skills?.() ?? [],
        promptTemplates: deps.promptTemplates?.() ?? [],
        ...(deps.systemPrompt === undefined
          ? {}
          : { systemPrompt: deps.systemPrompt }),
        cwd: deps.cwd
      });
    return new PiExtensionRuntime(runner, states, eventBus, resources, deps);
  }

  /** The extension-registered tools, adapted for the durable harness. */
  tools(): AgentHarnessTool<object | undefined>[] {
    return adaptExtensionTools(this.#runner, {
      states: this.#states,
      // The harness's own mapping is authoritative; without one the live
      // turn the call belongs to still names its lane.
      laneForInvocation: (invocation) =>
        this.#deps.laneForInvocation?.(invocation) ??
        this.#events.laneForTurn(invocation.turnId)
    });
  }

  /**
   * Every slash command this session offers: extension commands first, then
   * prompt templates, then skills.
   */
  commands(): readonly SlashCommandInfo[] {
    return slashCommandInfos({
      extension: this.#runner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        ...(command.description === undefined
          ? {}
          : { description: command.description }),
        source: "extension" as const,
        sourceInfo: command.sourceInfo
      })),
      promptTemplates: this.#deps.promptTemplates?.() ?? [],
      skills: this.#deps.skills?.() ?? []
    });
  }

  /** The same commands, in the shape clients autocomplete from. */
  slashCommands(): PiSlashCommand[] {
    return piSlashCommands(this.commands());
  }

  /** Whether an extension registered a command under this name. */
  hasCommand(name: string): boolean {
    return this.#runner.getCommand(name) !== undefined;
  }

  /**
   * Run one extension slash command out of band.
   *
   * Commands are not durable operations: they act through the same lane
   * actions an event handler uses, and are gone if the isolate dies
   * mid-handler. Resolves once the handler returned and the writes it queued
   * on the lane have drained, so a caller's receipt means the command ran.
   * Returns false when no extension owns the name.
   */
  async runCommand(lane: string, name: string, args: string): Promise<boolean> {
    if (this.#stopped) return false;
    const command = this.#runner.getCommand(name);
    if (!command) return false;
    try {
      await this.#states.withLane(lane, async () => {
        await this.#refresh(lane);
        await command.handler(args, this.#runner.createCommandContext());
      });
    } catch (error) {
      this.#deps.report({
        lane,
        kind: "extension",
        source: `command:${name}`,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined
          ? { stack: error.stack }
          : {})
      });
    }
    await this.drain(lane);
    return true;
  }

  /** Current values of every registered flag. */
  flags(): Map<string, boolean | string> {
    return this.#runner.getFlagValues();
  }

  /** Current values of every registered flag, as a plain object. */
  flagValues(): Record<string, boolean | string> {
    return Object.fromEntries(this.flags());
  }

  /**
   * Set one flag value.
   *
   * Only a flag an extension registered can be set, and only to its own
   * type: the flag map is process-local state the client can write to, so an
   * unchecked name would grow it without bound and an unchecked value would
   * hand `pi.getFlag` a type its extension never registered. Both are
   * refused with an error the caller sees.
   */
  setFlag(name: string, value: boolean | string): void {
    const flag = this.#runner.getFlags().get(name);
    if (!flag) {
      throw new Error(`No extension registered a flag named ${quoted(name)}`);
    }
    if (typeof value !== flag.type) {
      throw new Error(
        `Flag ${quoted(name)} is a ${flag.type} flag, but the value is a ${typeof value}`
      );
    }
    this.#runner.setFlagValue(name, value);
  }

  /** The lane whose hook, event or command is currently running. */
  get currentLane(): string {
    return this.#states.current.lane;
  }

  /** The resource surface this runtime serves to pi. */
  get resourceLoader(): ResourceLoader {
    this.#resources ??= this.#resourcesFactory();
    return this.#resources;
  }

  /** The runner itself, for the command and UI surfaces built on top. */
  get runner(): ExtensionRunner {
    return this.#runner;
  }

  /**
   * Bind everything that needs the attached harness, in pi's order: error
   * reporting, the UI context when a host supplies one, the action surfaces,
   * then the hooks. The session-start notification goes out last, once
   * extensions can act.
   */
  attach(hooks: Hooks): void {
    const deps = this.#deps;
    this.#runner.onError((error) => {
      deps.report({
        lane: this.#states.current.lane,
        kind: "extension",
        source: `${error.extensionPath}:${error.event}`,
        message: error.error,
        ...(error.stack === undefined ? {} : { stack: error.stack })
      });
    });
    // With a UI context the runner runs in "rpc" mode and `ctx.hasUI` is
    // true; without one it keeps pi's no-op UI.
    if (deps.uiContext) this.#runner.setUIContext(deps.uiContext, "rpc");
    const contextDeps: ExtensionContextActionDeps = {
      states: this.#states,
      cwd: deps.cwd,
      lane: deps.lane,
      compact: deps.compact,
      navigate: deps.navigate,
      report: deps.report
    };
    this.#runner.bindCore(
      createExtensionActions({
        states: this.#states,
        lane: deps.lane,
        setSessionName: deps.setSessionName,
        setLabel: deps.setLabel,
        refreshTools: deps.refreshTools,
        allTools: deps.allTools,
        commands: () => this.commands(),
        report: deps.report
      }),
      createExtensionContextActions(contextDeps)
    );
    this.#runner.bindCommandContext(
      createExtensionCommandContextActions(contextDeps)
    );
    this.#unbindHooks = bindExtensionHooks(hooks, this.#runner, {
      states: this.#states,
      cwd: deps.cwd,
      refresh: (lane) => this.#refresh(lane),
      systemPrompt: (lane, state) => this.#systemPrompt(lane, state),
      report: deps.report
    });
    this.#events.start();
  }

  /** Forward one harness event to the extensions' notification handlers. */
  dispatch(event: HarnessEvent): void {
    if (this.#stopped) return;
    this.#events.dispatch(event);
  }

  /**
   * Run pi's `input` event over one submitted prompt.
   *
   * A handler may consume the submission outright or rewrite it. This is the
   * only interception point ahead of the durable queue, so it runs before the
   * harness records anything.
   */
  async emitInput(
    text: string,
    images: readonly ImageContent[] | undefined,
    source: InputSource,
    lane: string = this.#states.current.lane
  ): Promise<InputEventResult> {
    if (this.#stopped) return { action: "continue" };
    try {
      // An input handler writes through the same synchronous surface a hook
      // does, so it runs inside the submitting lane's scope rather than
      // against whichever lane happened to be current.
      return await this.#states.withLane(lane, async () => {
        await this.#refresh(lane);
        return this.#runner.emitInput(
          text,
          images === undefined ? undefined : [...images],
          source
        );
      });
    } catch (error) {
      this.#deps.report({
        lane,
        kind: "event",
        source: "input",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined
          ? { stack: error.stack }
          : {})
      });
      return { action: "continue" };
    }
  }

  /**
   * Wait for one lane's queued extension writes to reach durable storage.
   *
   * Extension actions are synchronous to their caller and append to a
   * per-lane write chain, so a handler that returned has not necessarily
   * written yet. A caller that reports an outcome to a client — a handled
   * or transformed submission, a slash command — awaits this first, or the
   * client reads the transcript back before the handler's writes landed.
   */
  async drain(lane: string): Promise<void> {
    await this.#events.drain();
    await this.#states.get(lane).drain();
  }

  /** Make one lane the target of subsequent synchronous extension calls. */
  enter(lane: string): void {
    this.#states.enter(lane);
  }

  /** Tear the runtime down with the harness it was attached to. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unbindHooks?.();
    this.#unbindHooks = undefined;
    await this.#events.stop().catch(() => {});
    for (const state of this.#states.all()) {
      await state.drain().catch(() => {});
    }
    this.#eventBus.clear();
  }

  /**
   * The system prompt to show `before_agent_start`, best first.
   *
   * The harness's own resolver is authoritative; the cached read model holds
   * the last request's prompt, which is empty before the first one; the
   * configured prompt is the last resort and is at least the prompt the
   * session was built with.
   */
  async #systemPrompt(
    lane: string,
    state: ExtensionLaneState
  ): Promise<string> {
    const resolve = this.#deps.resolveSystemPrompt;
    if (resolve) {
      try {
        return await resolve(lane);
      } catch (error) {
        this.#deps.report({
          lane,
          kind: "hook",
          source: "before_run",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined
            ? { stack: error.stack }
            : {})
        });
      }
    }
    return state.systemPrompt || (this.#deps.systemPrompt ?? "");
  }

  async #refresh(lane: string): Promise<void> {
    const state = this.#states.get(lane);
    const context: Context = BACKGROUND_CONTEXT;
    await state.refresh(
      await this.#deps.lane(lane),
      context,
      this.#deps.pendingSubmissions?.(lane) ?? 0
    );
  }
}

export type { PiExtensionErrorReporter, PiExtensionHandlerError };
