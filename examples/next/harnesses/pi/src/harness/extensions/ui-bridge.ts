import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  WorkingIndicatorOptions
} from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { Theme } from "../../../vendor/pi-coding-agent-src/modes/interactive/theme/theme.ts";
import { theme } from "../../../vendor/pi-coding-agent-src/modes/interactive/theme/theme.ts";
import type { PiExtensionUiRequest, PiExtensionUiResponse } from "../types";

/**
 * Raised when a blocking dialog has nobody to answer it.
 *
 * The alternative is to invent an answer — and the default answer to
 * `confirm` is false, which an extension reads as "the user declined" when
 * no user was ever asked. A permission gate that silently denies is as
 * dishonest as one that silently allows, so the dialog throws instead: a
 * tool call gated on it is blocked with this message as its reason, which
 * says what actually happened.
 */
export class NoExtensionUiError extends Error {
  /** The dialog method that had no audience. */
  readonly method: string;

  constructor(method: string) {
    super(`No client is connected to answer the ${method} request`);
    this.name = "NoExtensionUiError";
    this.method = method;
  }
}

/** What the bridge needs from its host to reach a lane's clients. */
export type PiUiBridgeDeps = {
  /** The lane these dialogs belong to; carried on every broadcast frame. */
  readonly lane: string;
  /** Broadcast one request and report how many clients received it. */
  readonly broadcast: (request: PiExtensionUiRequest) => number;
  /** Default dialog timeout when the extension does not name one. */
  readonly timeoutMs: number;
  /**
   * A dialog stopped waiting — answered, timed out, aborted, or never
   * delivered. Clients showing it have to be told, or the modal outlives the
   * request that raised it.
   */
  readonly onSettled?: (requestId: string) => void;
};

/** A UI context plus the handles the transport needs to answer it. */
export type PiUiBridge = {
  /** The `ExtensionUIContext` handed to `ExtensionRunner.setUIContext`. */
  readonly ui: ExtensionUIContext;
  /** Deliver a client's answer. False when the request is unknown or settled. */
  resolve(requestId: string, response: PiExtensionUiResponse): boolean;
  /** Settle every open dialog with its default value. */
  abortAll(reason?: string): void;
  /** How many dialogs are waiting for an answer. */
  pending(): number;
};

type PendingDialog = {
  /** Settle with a client's answer. */
  readonly deliver: (response: PiExtensionUiResponse) => void;
  /** Settle with the dialog's default value. */
  readonly settleDefault: () => void;
};

/**
 * An `ExtensionUIContext` served over the harness's WebSocket protocol.
 *
 * Ported from pi's RPC mode — `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
 * at c4b0e35a, `createDialogPromise` (lines 91-131) and
 * `createExtensionUIContext` (lines 136-311) — with stdout swapped for a
 * per-lane broadcast. Terminal-only methods stay no-ops exactly as upstream.
 *
 * Two deliberate differences from upstream, both so an extension can never
 * wedge a hook gate open inside a Durable Object:
 *
 * - a dialog broadcast to zero subscribers rejects with
 *   {@link NoExtensionUiError} immediately, rather than waiting for a client
 *   that may never connect. It rejects rather than settling with its default
 *   because the default is an answer, and nobody gave one;
 * - every dialog carries a timeout (`opts.timeout`, else `deps.timeoutMs`),
 *   including `editor`, which upstream leaves open indefinitely. A dialog
 *   that timed out did reach a client, so that one settles with its default.
 *
 * `opts.timeout` is milliseconds, per `ExtensionUIDialogOptions`.
 */
export function createWebSocketUIContext(deps: PiUiBridgeDeps): PiUiBridge {
  const pending = new Map<string, PendingDialog>();

  const emit = (request: PiExtensionUiRequest): number => {
    try {
      return deps.broadcast(request);
    } catch {
      // A broadcast failure is indistinguishable from no listeners: the
      // dialog falls back to its default and the extension carries on.
      return 0;
    }
  };

  /** Upstream `createDialogPromise`, with one rejection path of its own. */
  function dialog<T>(
    method: string,
    opts: ExtensionUIDialogOptions | undefined,
    defaultValue: T,
    build: (requestId: string, timeoutMs: number) => PiExtensionUiRequest,
    parse: (response: PiExtensionUiResponse) => T
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

    const requestId = crypto.randomUUID();
    const timeoutMs = opts?.timeout ?? deps.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (pending.delete(requestId)) deps.onSettled?.(requestId);
      };

      const settleDefault = () => {
        cleanup();
        resolve(defaultValue);
      };

      function onAbort() {
        settleDefault();
      }
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      pending.set(requestId, {
        deliver: (response) => {
          cleanup();
          resolve(parse(response));
        },
        settleDefault
      });

      if (emit(build(requestId, timeoutMs)) === 0) {
        cleanup();
        reject(new NoExtensionUiError(method));
        return;
      }
      timer = setTimeout(settleDefault, timeoutMs);
    });
  }

  /** Fire-and-forget view updates carry an id for symmetry, never an answer. */
  const announce = (
    build: (requestId: string) => PiExtensionUiRequest
  ): void => {
    emit(build(crypto.randomUUID()));
  };

  const ui: ExtensionUIContext = {
    select: (title, options, opts) =>
      dialog(
        "select",
        opts,
        undefined,
        (requestId, timeoutMs) => ({
          method: "select",
          requestId,
          title,
          options,
          timeoutMs
        }),
        (response) =>
          "cancelled" in response
            ? undefined
            : "value" in response
              ? response.value
              : undefined
      ),

    confirm: (title, message, opts) =>
      dialog(
        "confirm",
        opts,
        false,
        (requestId, timeoutMs) => ({
          method: "confirm",
          requestId,
          title,
          message,
          timeoutMs
        }),
        (response) =>
          "cancelled" in response
            ? false
            : "confirmed" in response
              ? response.confirmed
              : false
      ),

    input: (title, placeholder, opts) =>
      dialog(
        "input",
        opts,
        undefined,
        (requestId, timeoutMs) => ({
          method: "input",
          requestId,
          title,
          ...(placeholder === undefined ? {} : { placeholder }),
          timeoutMs
        }),
        (response) =>
          "cancelled" in response
            ? undefined
            : "value" in response
              ? response.value
              : undefined
      ),

    editor: (title, prefill) =>
      dialog(
        "editor",
        undefined,
        undefined,
        (requestId, timeoutMs) => ({
          method: "editor",
          requestId,
          title,
          ...(prefill === undefined ? {} : { prefill }),
          timeoutMs
        }),
        (response) =>
          "cancelled" in response
            ? undefined
            : "value" in response
              ? response.value
              : undefined
      ),

    notify(message: string, type?: "info" | "warning" | "error"): void {
      announce((requestId) => ({
        method: "notify",
        requestId,
        message,
        ...(type === undefined ? {} : { level: type })
      }));
    },

    setStatus(key: string, text: string | undefined): void {
      announce((requestId) => ({
        method: "set_status",
        requestId,
        key,
        text
      }));
    },

    setWidget(
      key: string,
      content: unknown,
      options?: ExtensionWidgetOptions
    ): void {
      // Only string arrays cross the wire; component factories need a TUI.
      if (content !== undefined && !Array.isArray(content)) return;
      announce((requestId) => ({
        method: "set_widget",
        requestId,
        key,
        lines: content as readonly string[] | undefined,
        ...(options?.placement === undefined
          ? {}
          : { placement: options.placement })
      }));
    },

    setTitle(title: string): void {
      announce((requestId) => ({ method: "set_title", requestId, title }));
    },

    setEditorText(text: string): void {
      announce((requestId) => ({
        method: "set_editor_text",
        requestId,
        text
      }));
    },

    pasteToEditor(text: string): void {
      // Paste handling needs an editor component; fall back as upstream does.
      ui.setEditorText(text);
    },

    getEditorText(): string {
      // A synchronous read cannot wait for a client round trip.
      return "";
    },

    onTerminalInput(): () => void {
      // Raw terminal input: no terminal behind a Durable Object.
      return () => {};
    },

    setWorkingMessage(_message?: string): void {
      // Working message needs TUI loader access.
    },

    setWorkingVisible(_visible: boolean): void {
      // Working visibility needs TUI loader access.
    },

    setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
      // Working indicator customization needs TUI loader access.
    },

    setHiddenThinkingLabel(_label?: string): void {
      // Hidden thinking label needs TUI message rendering access.
    },

    setFooter(_factory: unknown): void {
      // Custom footer needs TUI access.
    },

    setHeader(_factory: unknown): void {
      // Custom header needs TUI access.
    },

    async custom() {
      // Custom components need TUI access.
      return undefined as never;
    },

    addAutocompleteProvider(): void {
      // Autocomplete provider composition needs an editor component.
    },

    setEditorComponent(): void {
      // Custom editor components need TUI access.
    },

    getEditorComponent() {
      return undefined;
    },

    get theme(): Theme {
      return theme;
    },

    getAllThemes() {
      return [];
    },

    getTheme(_name: string) {
      return undefined;
    },

    setTheme(_theme: string | Theme) {
      return { success: false, error: "Theme switching is not supported" };
    },

    getToolsExpanded() {
      return false;
    },

    setToolsExpanded(_expanded: boolean) {
      // Tool expansion is a TUI concern.
    }
  };

  return {
    ui,
    resolve(requestId, response) {
      const entry = pending.get(requestId);
      if (!entry) return false;
      entry.deliver(response);
      return true;
    },
    abortAll(_reason?: string) {
      // Settle rather than reject: an unanswered dialog is a default answer,
      // and a rejection here would surface as an unhandled promise in the DO.
      for (const entry of [...pending.values()]) entry.settleDefault();
      pending.clear();
    },
    pending: () => pending.size
  };
}

/** Every lane's bridge, behind one `ExtensionUIContext`. */
export type PiLaneUiBridges = {
  /**
   * The context handed to `ExtensionRunner.setUIContext`. The runner is
   * per-harness while dialogs are per-lane, so every call routes to the
   * bridge of the lane whose hook, event or tool is running.
   */
  readonly ui: ExtensionUIContext;
  /** The bridge serving one lane, created on first use. */
  bridge(lane: string): PiUiBridge;
  /** Deliver a client's answer to whichever lane is waiting for it. */
  resolve(requestId: string, response: PiExtensionUiResponse): boolean;
  /** Settle every open dialog on every lane with its default value. */
  abortAll(reason?: string): void;
  /** How many dialogs are waiting for an answer, across every lane. */
  pending(): number;
};

/** What the per-lane bridge set needs from its host. */
export type PiLaneUiBridgeDeps = {
  /** The lane extension code is currently running on. */
  readonly lane: () => string;
  /** Broadcast one request to a lane and report how many clients received it. */
  readonly broadcast: (lane: string, request: PiExtensionUiRequest) => number;
  readonly timeoutMs: number;
  /** A dialog on `lane` stopped waiting; see {@link PiUiBridgeDeps.onSettled}. */
  readonly onSettled?: (lane: string, requestId: string) => void;
};

/**
 * One {@link createWebSocketUIContext} per lane, addressed as a single
 * context.
 *
 * Lanes are independent conversations with independent subscribers, so a
 * dialog raised while a lane's hook runs has to reach that lane's clients and
 * no one else's. The routing is a proxy rather than a hand-written forward of
 * all ~28 members so that a member added upstream routes without a code
 * change here.
 */
export function createLaneUiBridges(deps: PiLaneUiBridgeDeps): PiLaneUiBridges {
  const bridges = new Map<string, PiUiBridge>();

  const bridge = (lane: string): PiUiBridge => {
    let existing = bridges.get(lane);
    if (!existing) {
      existing = createWebSocketUIContext({
        lane,
        broadcast: (request) => deps.broadcast(lane, request),
        timeoutMs: deps.timeoutMs,
        onSettled: (requestId) => deps.onSettled?.(lane, requestId)
      });
      bridges.set(lane, existing);
    }
    return existing;
  };

  const ui = new Proxy({} as ExtensionUIContext, {
    // SAFETY: every read is served by a real ExtensionUIContext, so the
    // proxy's shape is exactly that of the lane's bridge.
    get: (_target, property) =>
      Reflect.get(bridge(deps.lane()).ui, property) as unknown,
    has: (_target, property) => property in bridge(deps.lane()).ui,
    ownKeys: () => Reflect.ownKeys(bridge(deps.lane()).ui),
    getOwnPropertyDescriptor: (_target, property) => ({
      ...Reflect.getOwnPropertyDescriptor(bridge(deps.lane()).ui, property),
      configurable: true,
      enumerable: true
    })
  });

  return {
    ui,
    bridge,
    resolve(requestId, response) {
      for (const candidate of bridges.values()) {
        if (candidate.resolve(requestId, response)) return true;
      }
      return false;
    },
    abortAll(reason) {
      for (const candidate of bridges.values()) candidate.abortAll(reason);
    },
    pending() {
      let total = 0;
      for (const candidate of bridges.values()) total += candidate.pending();
      return total;
    }
  };
}
