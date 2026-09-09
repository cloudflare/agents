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
import type { PiExtension, PiPromptTemplate } from "../types";
import { createExtensionActions } from "./actions";
import {
  createExtensionCommandContextActions,
  createExtensionContextActions,
  type ExtensionContextActionDeps
} from "./context-actions";
import { ExtensionEventAdapter } from "./events-adapter";
import { bindExtensionHooks } from "./hooks-adapter";
import { createExtensionModelRegistry } from "./model-registry";
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
  #unbindHooks: (() => void) | undefined;
  #stopped = false;

  private constructor(
    runner: ExtensionRunner,
    states: ExtensionLaneStates,
    eventBus: ReturnType<typeof createEventBus>,
    deps: PiExtensionRuntimeDeps
  ) {
    this.#runner = runner;
    this.#states = states;
    this.#eventBus = eventBus;
    this.#deps = deps;
    this.#events = new ExtensionEventAdapter(runner, {
      states,
      cwd: deps.cwd,
      resolveModel: (provider, modelId) =>
        // SAFETY: the registry returns pi-ai catalog models; PiModel is the
        // narrow public projection of the same object.
        deps.models.getModel(provider, modelId) as Model<Api> | undefined,
      report: deps.report
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
    return new PiExtensionRuntime(runner, states, eventBus, deps);
  }

  /** The extension-registered tools, adapted for the durable harness. */
  tools(): AgentHarnessTool<object | undefined>[] {
    return adaptExtensionTools(this.#runner);
  }

  /** Slash commands the loaded extensions registered. */
  commands(): readonly SlashCommandInfo[] {
    return this.#runner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      ...(command.description === undefined
        ? {}
        : { description: command.description }),
      source: "extension" as const,
      sourceInfo: command.sourceInfo
    }));
  }

  /** Current values of every registered flag. */
  flags(): Map<string, boolean | string> {
    return this.#runner.getFlagValues();
  }

  /** Set one flag value. */
  setFlag(name: string, value: boolean | string): void {
    this.#runner.setFlagValue(name, value);
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
