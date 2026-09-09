import {
  BACKGROUND_CONTEXT,
  type AgentHarnessTool,
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
  /** Prompt templates offered alongside extension commands. */
  readonly promptTemplates?: readonly PiPromptTemplate[];
  /** Skills invocable by name, as the harness resolved them. */
  readonly skills?: () => readonly PiSkill[];
  /** The harness's system prompt, when the configuration fixed one. */
  readonly systemPrompt?: string;
  /** Resource surface served to pi, replacing the in-memory default. */
  readonly resourceLoader?: ResourceLoader;
  /** Command runner behind `pi.exec`, when the harness has one. */
  readonly shell?: Shell;
  /** Resolve one lane of the attached harness. */
  readonly lane: (name: string) => Promise<AgentLane>;
  /** Rename the session. */
  readonly setSessionName: (name: string) => Promise<void>;
  /** Label one transcript entry. */
  readonly setLabel: (
    entryId: string,
    label: string | undefined
  ) => Promise<void>;
  /** Re-resolve the process-local tool registry after a registration change. */
  readonly refreshTools: () => void;
  /** Every tool currently offered to the model. */
  readonly allTools: () => readonly ToolInfo[];
  /** Durably submit one compaction. */
  readonly compact: ExtensionContextActionDeps["compact"];
  /** Durably submit one tree navigation. */
  readonly navigate: ExtensionContextActionDeps["navigate"];
  /** Report a handler failure onto the lane's event stream. */
  readonly report: PiExtensionErrorReporter;
  /**
   * PHASE 6 INJECTION POINT — the blocking UI surface `ctx.ui` exposes.
   * Left undefined here, so the runner keeps pi's no-op UI context and
   * `ctx.hasUI` is false. The UI bridge passes its own context, and the
   * runtime switches the runner into `"rpc"` mode.
   */
  readonly uiContext?: ExtensionUIContext;
};

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
    // Configured values win over the defaults registered above.
    for (const [name, value] of Object.entries(deps.flags ?? {})) {
      runner.setFlagValue(name, value);
    }
    // Built on first read, not here: skills and templates are resolved by the
    // harness after the registration pass this method runs.
    const resources = (): ResourceLoader =>
      deps.resourceLoader ??
      createResourceLoader({
        extensions: { extensions: loaded, errors, runtime },
        skills: deps.skills?.() ?? [],
        promptTemplates: deps.promptTemplates ?? [],
        ...(deps.systemPrompt === undefined
          ? {}
          : { systemPrompt: deps.systemPrompt }),
        cwd: deps.cwd
      });
    return new PiExtensionRuntime(runner, states, eventBus, resources, deps);
  }

  /** The extension-registered tools, adapted for the durable harness. */
  tools(): AgentHarnessTool<object | undefined>[] {
    return adaptExtensionTools(this.#runner);
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
      promptTemplates: this.#deps.promptTemplates ?? [],
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
    this.enter(lane);
    try {
      await this.#refresh(lane);
      await command.handler(args, this.#runner.createCommandContext());
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
    await this.#states.get(lane).drain();
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

  /** Set one flag value. */
  setFlag(name: string, value: boolean | string): void {
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
    // PHASE 6 INJECTION POINT: with a UI context the runner runs in "rpc"
    // mode and `ctx.hasUI` is true; without one it keeps pi's no-op UI.
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
    source: InputSource
  ): Promise<InputEventResult> {
    if (this.#stopped) return { action: "continue" };
    try {
      await this.#refresh(this.#states.current.lane);
      return await this.#runner.emitInput(
        text,
        images === undefined ? undefined : [...images],
        source
      );
    } catch (error) {
      this.#deps.report({
        lane: this.#states.current.lane,
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

  async #refresh(lane: string): Promise<void> {
    const state = this.#states.get(lane);
    const context: Context = BACKGROUND_CONTEXT;
    state.signal = context.abortSignal;
    await state.refresh(await this.#deps.lane(lane), context);
  }
}

export type { PiExtensionErrorReporter, PiExtensionHandlerError };
