import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  WorkingIndicatorOptions
} from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { Theme } from "../../../vendor/pi-coding-agent-src/modes/interactive/theme/theme.ts";
import { theme } from "../../../vendor/pi-coding-agent-src/modes/interactive/theme/theme.ts";
import type { PiExtensionUiRequest, PiExtensionUiResponse } from "../types";

/** What the bridge needs from its host to reach a lane's clients. */
export type PiUiBridgeDeps = {
  /** The lane these dialogs belong to; carried on every broadcast frame. */
  readonly lane: string;
  /** Broadcast one request and report how many clients received it. */
  readonly broadcast: (request: PiExtensionUiRequest) => number;
  /** Default dialog timeout when the extension does not name one. */
  readonly timeoutMs: number;
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
 * - a dialog broadcast to zero subscribers settles with its default
 *   immediately, rather than waiting for a client that may never connect;
 * - every dialog carries a timeout (`opts.timeout`, else `deps.timeoutMs`),
 *   including `editor`, which upstream leaves open indefinitely.
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

  /** Upstream `createDialogPromise`, minus the reject path. */
  function dialog<T>(
    opts: ExtensionUIDialogOptions | undefined,
    defaultValue: T,
    build: (requestId: string, timeoutMs: number) => PiExtensionUiRequest,
    parse: (response: PiExtensionUiResponse) => T
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

    const requestId = crypto.randomUUID();
    const timeoutMs = opts?.timeout ?? deps.timeoutMs;
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        pending.delete(requestId);
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
        settleDefault();
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
