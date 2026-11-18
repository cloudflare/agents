/**
 * `HostObserver`: the host's own CDP connection to a session's browser, and
 * the record of what it saw.
 *
 * A `BrowserSession` opens one beside the model's connection when its
 * browser offers it (`BrowserConnection.observer`, opened at the same time
 * as the model's socket). It attaches to each tab the session attaches the
 * model to, enables Page and Network there, answers the page's dialogs, and
 * keeps a small record per tab: where the tab went, what each main document
 * returned, and which dialogs it answered. Its handlers only update that
 * record; the session reads it when it closes.
 *
 * It has its own WebSocket because Chrome keeps CDP sessions per connection:
 * model code can't address or detach the observer's sessions, its
 * `Page.disable` doesn't touch them, and the observer's commands and events
 * never reach the model's debug log. (Browser Run's `Cloudflare.*` events are
 * the exception: they arrive on every connection, tagged with every
 * connection's session ids, so the model's debug log can record the
 * observer's session id. That's harmless: the id doesn't work on the model's
 * socket.) What it records is still advice, not enforcement: the model can
 * close the tab or block requests.
 *
 * It never fails a run or holds up the model's commands. If it can't connect
 * in time, or a tab can't be observed, the session goes on without it and
 * the record says so.
 */

import type { BrowserObserverConnection } from "./browser";
import type { CdpConnection, CdpEvent } from "./cdp-connection";

/** How long a session waits for its observer to connect before going on without it. */
export const OBSERVER_CONNECT_TIMEOUT_MS = 2_000;

/**
 * The limit on each command that sets up a tab. Short, because a tab left
 * blocked by a dialog never answers them.
 */
const OBSERVER_SETUP_TIMEOUT_MS = 1_000;

/** The limit on the observer's other commands. */
const OBSERVER_COMMAND_TIMEOUT_MS = 2_000;

/** The limit on the last command per tab before the record is read. */
const OBSERVER_FLUSH_TIMEOUT_MS = 1_000;

/** Navigations, documents and dialogs kept per tab; older ones are dropped. */
const MAX_OBSERVED_ENTRIES_PER_TAB = 50;

/** Redirects kept per document. */
const MAX_OBSERVED_REDIRECTS = 20;

/** The longest dialog message kept. */
const MAX_DIALOG_MESSAGE_LENGTH = 200;

/** Dialog notices given to the model per session. */
const MAX_DIALOG_NOTICES = 5;

/** A main-frame navigation the observer saw. */
export interface BrowserObservedNavigation {
  url: string;
  /** A same-document navigation: a fragment change or `history.pushState`. */
  sameDocument?: true;
}

/** One redirect a main document went through. */
export interface BrowserObservedRedirect {
  url: string;
  status: number;
}

/** A main-frame document request and what it returned. */
export interface BrowserObservedDocument {
  /** The document's URL, after any redirects. */
  url: string;
  /** The HTTP status, once a response arrived. */
  status?: number;
  /** The redirects before it, oldest first. */
  redirects: BrowserObservedRedirect[];
  /** Why it failed, when it did (`Network.loadingFailed`'s `errorText`). */
  error?: string;
}

/** A JavaScript dialog the page opened, and how the observer answered it. */
export interface BrowserObservedDialog {
  /** `alert`, `confirm`, `prompt` or `beforeunload`. */
  type: string;
  /** The dialog's message, cut to 200 characters. */
  message: string;
  /** `true` when the observer accepted it, `false` when it dismissed it. */
  accepted: boolean;
}

/** What the observer saw in one tab. */
export interface BrowserObservedTab {
  targetId: string;
  /** Where the tab was when the observer attached. */
  initialUrl?: string;
  /** Main-frame navigations, oldest first. */
  navigations: BrowserObservedNavigation[];
  /** Main-frame document requests, oldest first. */
  documents: BrowserObservedDocument[];
  /** Dialogs the observer answered, oldest first. */
  dialogs: BrowserObservedDialog[];
  /**
   * The tab didn't answer the observer's setup while the browser did:
   * probably a dialog that opened while no observer was connected, which
   * nobody can answer now. Page commands in it time out until it's
   * reloaded or navigated. `url` is where it was.
   */
  blocked?: { url?: string };
  /** From attaching to the tab until its setup finished or gave up, in ms. */
  setupMs?: number;
}

/**
 * What a session's observer saw, or why there was nothing to see.
 * `connectMs` is how long its connection took to open, or to fail.
 *
 * @experimental The shape may change before stabilizing.
 */
export type BrowserObserverRecord =
  | { available: true; connectMs: number; tabs: BrowserObservedTab[] }
  | { available: false; reason: string; connectMs?: number };

interface ObservedTabState {
  record: BrowserObservedTab;
  /** The main frame's id: the target id until the frame tree says otherwise. */
  mainFrameId: string;
  /** Main documents waiting for a response, by request id. */
  loading: Map<string, BrowserObservedDocument>;
}

type Connected =
  | { cdp: CdpConnection; connectMs: number }
  | { cdp?: undefined; reason: string; connectMs?: number };

export class HostObserver {
  readonly #ready: Promise<Connected>;
  /** Each tab's setup, by target id, so a tab is attached once. */
  readonly #attaching = new Map<string, Promise<void>>();
  /** Observed tabs, by the observer's CDP session id. */
  readonly #tabsBySession = new Map<string, ObservedTabState>();
  /** Observed tabs in the order they were attached. */
  readonly #tabs: ObservedTabState[] = [];
  #closing?: Promise<BrowserObserverRecord>;
  /** The browser's name, for log messages. */
  readonly #browserName: string;

  /** Take a connection that is already opening; nothing waits for it here. */
  constructor(connection: BrowserObserverConnection, browserName: string) {
    this.#browserName = browserName;
    this.#ready = this.#connect(connection);
  }

  /**
   * Start observing a tab the session just attached the model to. Returns
   * at once: the model's commands never wait for the observer, so events
   * from a command sent before the setup finishes can be missed.
   */
  attach(targetId: string): void {
    if (this.#closing || this.#attaching.has(targetId)) return;
    this.#attaching.set(targetId, this.#attachTab(targetId));
  }

  /**
   * Read the record and close the connection. Waits for tab setups still
   * running, then sends one last command to each tab and waits for its
   * reply, so the events Chrome sent before it have arrived. Never rejects;
   * later calls resolve with the same record.
   */
  close(): Promise<BrowserObserverRecord> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<BrowserObserverRecord> {
    const connected = await this.#ready;
    if (!connected.cdp) {
      const { reason, connectMs } = connected;
      return {
        available: false,
        reason,
        ...(connectMs !== undefined ? { connectMs } : {})
      };
    }
    const { cdp, connectMs } = connected;
    try {
      await Promise.allSettled(this.#attaching.values());
      await Promise.allSettled(
        [...this.#tabsBySession]
          .filter(([, tab]) => !tab.record.blocked)
          .map(([sessionId]) =>
            cdp.send("Page.getFrameTree", undefined, {
              sessionId,
              timeoutMs: OBSERVER_FLUSH_TIMEOUT_MS
            })
          )
      );
    } finally {
      cdp.disconnect();
    }
    return {
      available: true,
      connectMs,
      tabs: this.#tabs.map(({ record }) => structuredClone(record))
    };
  }

  async #connect({
    connecting,
    startedAt
  }: BrowserObserverConnection): Promise<Connected> {
    const elapsed = () => Date.now() - startedAt;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(
        () => resolve("timeout"),
        Math.max(0, OBSERVER_CONNECT_TIMEOUT_MS - elapsed())
      );
    });
    let outcome: CdpConnection | "timeout";
    try {
      outcome = await Promise.race([connecting, timedOut]);
    } catch (error) {
      const reason = `the observer couldn't connect: ${errorMessage(error)}`;
      this.#warn("connect", error);
      return { reason, connectMs: elapsed() };
    } finally {
      clearTimeout(timeoutId);
    }
    if (outcome === "timeout") {
      const reason = `the observer didn't connect within ${OBSERVER_CONNECT_TIMEOUT_MS}ms`;
      this.#warn("connect", new Error(reason));
      // Drop the connection if it arrives late.
      connecting.then(
        (late) => late.disconnect(),
        () => undefined
      );
      return { reason };
    }
    const connectMs = elapsed();
    // Closed while connecting: close() disconnects it.
    if (!this.#closing) this.#listen(outcome);
    return { cdp: outcome, connectMs };
  }

  async #attachTab(targetId: string): Promise<void> {
    const connected = await this.#ready;
    const { cdp } = connected;
    if (!cdp || this.#closing) return;
    const startedAt = Date.now();
    let sessionId: string;
    try {
      sessionId = await cdp.attachToTarget(targetId, {
        timeoutMs: OBSERVER_COMMAND_TIMEOUT_MS
      });
    } catch (error) {
      this.#warn(`attach to tab ${targetId}`, error);
      return;
    }
    const tab: ObservedTabState = {
      record: { targetId, navigations: [], documents: [], dialogs: [] },
      mainFrameId: targetId,
      loading: new Map()
    };
    this.#tabsBySession.set(sessionId, tab);
    this.#tabs.push(tab);
    const send = (method: string, params?: unknown) =>
      cdp.send(method, params, {
        sessionId,
        timeoutMs: OBSERVER_SETUP_TIMEOUT_MS
      });
    // Sent together: each costs a round trip, and none needs another.
    const [page, network, frameTree] = await Promise.allSettled([
      send("Page.enable"),
      send("Network.enable", {
        // Request bodies never reach the host, and Chrome keeps no
        // response bodies for it.
        maxPostDataSize: 0,
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0
      }),
      send("Page.getFrameTree")
    ]);
    if (frameTree.status === "fulfilled") {
      const frame = mainFrameOf(frameTree.value);
      if (frame) {
        tab.mainFrameId = frame.id;
        tab.record.initialUrl = frame.url;
      }
    }
    const failed = [page, network, frameTree].find(
      (result) => result.status === "rejected"
    );
    if (failed) {
      await this.#checkBlocked(cdp, tab, failed.reason);
    }
    tab.record.setupMs = Date.now() - startedAt;
  }

  /**
   * The tab didn't answer its setup. If the browser still answers for it,
   * the tab is blocked, most likely by a dialog that opened while no
   * observer was connected: only a session with Page enabled before a
   * dialog opens can answer it. Recovering means reloading or navigating
   * the tab, which is left to the model.
   */
  async #checkBlocked(
    cdp: CdpConnection,
    tab: ObservedTabState,
    setupError: unknown
  ): Promise<void> {
    const { targetId } = tab.record;
    try {
      const info = await cdp.send(
        "Target.getTargetInfo",
        { targetId },
        { timeoutMs: OBSERVER_SETUP_TIMEOUT_MS }
      );
      const url = asRecord(asRecord(info)?.targetInfo)?.url;
      tab.record.blocked = typeof url === "string" ? { url } : {};
    } catch {
      // The browser doesn't answer either: not a stuck tab.
    }
    this.#warn(`set up tab ${targetId}`, setupError);
  }

  #listen(cdp: CdpConnection): void {
    // Hear only this connection's own sessions and the browser itself:
    // Browser Run sends its `Cloudflare.*` events to every connection,
    // tagged with other connections' session ids.
    const on = (method: string, handle: (event: CdpEvent) => void) =>
      cdp.on(method, (event) => {
        if (
          event.sessionId === undefined ||
          this.#tabsBySession.has(event.sessionId)
        ) {
          handle(event);
        }
      });
    on("Page.javascriptDialogOpening", (event) => {
      const tab = this.#tab(event);
      if (tab && event.sessionId) this.#answerDialog(cdp, tab, event);
    });
    on("Page.frameNavigated", (event) => {
      const tab = this.#tab(event);
      const frame = asRecord(event.params.frame);
      if (!tab || !frame || frame.parentId !== undefined) return;
      if (typeof frame.id === "string") tab.mainFrameId = frame.id;
      if (typeof frame.url !== "string") return;
      const fragment =
        typeof frame.urlFragment === "string" ? frame.urlFragment : "";
      keepLast(tab.record.navigations, { url: frame.url + fragment });
    });
    on("Page.navigatedWithinDocument", (event) => {
      const tab = this.#tab(event);
      const { frameId, url } = event.params;
      if (!tab || frameId !== tab.mainFrameId || typeof url !== "string") {
        return;
      }
      keepLast(tab.record.navigations, { url, sameDocument: true });
    });
    // Network sends an event for every request: drop all but the main
    // frame's documents on arrival.
    on("Network.requestWillBeSent", (event) => {
      const { params } = event;
      if (params.type !== "Document") return;
      const tab = this.#tab(event);
      if (!tab || params.frameId !== tab.mainFrameId) return;
      const requestId = String(params.requestId);
      const url = asRecord(params.request)?.url;
      if (typeof url !== "string") return;
      const redirect = asRecord(params.redirectResponse);
      const redirected = tab.loading.get(requestId);
      if (redirect && redirected) {
        keepLast(
          redirected.redirects,
          { url: String(redirect.url), status: Number(redirect.status) },
          MAX_OBSERVED_REDIRECTS
        );
        redirected.url = url;
        return;
      }
      const document: BrowserObservedDocument = { url, redirects: [] };
      keepLast(tab.record.documents, document);
      tab.loading.set(requestId, document);
      // Forget requests whose documents were dropped from the record.
      if (tab.loading.size > MAX_OBSERVED_ENTRIES_PER_TAB) {
        const oldest = tab.loading.keys().next().value;
        if (oldest !== undefined) tab.loading.delete(oldest);
      }
    });
    on("Network.responseReceived", (event) => {
      const { params } = event;
      if (params.type !== "Document") return;
      const document = this.#loading(event);
      const response = asRecord(params.response);
      if (!document || !response) return;
      if (typeof response.url === "string") document.url = response.url;
      if (typeof response.status === "number") {
        document.status = response.status;
      }
      this.#tab(event)?.loading.delete(String(params.requestId));
    });
    on("Network.loadingFailed", (event) => {
      const { params } = event;
      if (params.type !== "Document") return;
      const document = this.#loading(event);
      if (!document) return;
      document.error = String(params.errorText ?? "failed");
      this.#tab(event)?.loading.delete(String(params.requestId));
    });
    on("Target.detachedFromTarget", (event) => {
      const { sessionId } = event.params;
      if (typeof sessionId === "string") this.#tabsBySession.delete(sessionId);
    });
  }

  /**
   * Answer a page's dialog as soon as it opens. On Browser Run nothing
   * else answers one: the tab's later commands hang, whether or not any
   * session has Page enabled, and model code never gets the event. `alert`
   * is accepted and `beforeunload` too, so navigation goes ahead; `confirm`
   * and `prompt` are dismissed, so the host never says yes for the model.
   */
  #answerDialog(
    cdp: CdpConnection,
    tab: ObservedTabState,
    event: CdpEvent
  ): void {
    const type = String(event.params.type ?? "alert");
    const accepted = type === "alert" || type === "beforeunload";
    cdp
      .send(
        "Page.handleJavaScriptDialog",
        { accept: accepted },
        { sessionId: event.sessionId, timeoutMs: OBSERVER_COMMAND_TIMEOUT_MS }
      )
      .catch((error: unknown) => this.#warn(`answer a ${type} dialog`, error));
    keepLast(tab.record.dialogs, {
      type,
      message: String(event.params.message ?? "").slice(
        0,
        MAX_DIALOG_MESSAGE_LENGTH
      ),
      accepted
    });
  }

  #tab(event: CdpEvent): ObservedTabState | undefined {
    return event.sessionId === undefined
      ? undefined
      : this.#tabsBySession.get(event.sessionId);
  }

  #loading(event: CdpEvent): BrowserObservedDocument | undefined {
    return this.#tab(event)?.loading.get(String(event.params.requestId));
  }

  #warn(action: string, error: unknown): void {
    console.warn(
      `[agents/browser] The observer failed to ${action} for browser "${this.#browserName}"`,
      error
    );
  }
}

/**
 * What the model should hear about from the observer's record: the dialogs
 * it answered, and tabs a dialog left blocked.
 */
export function observerNotices(
  record: BrowserObserverRecord | undefined
): string[] {
  if (!record?.available) return [];
  const notices: string[] = [];
  const dialogs = record.tabs.flatMap((tab) =>
    tab.dialogs.map((dialog) => ({ tab, dialog }))
  );
  for (const { dialog } of dialogs.slice(0, MAX_DIALOG_NOTICES)) {
    notices.push(
      `The page opened ${dialog.type === "alert" ? "an" : "a"} ${dialog.type} dialog (${JSON.stringify(dialog.message)}), and the host ${dialog.accepted ? "accepted" : "dismissed"} it${dialogEffect(dialog)}.`
    );
  }
  if (dialogs.length > MAX_DIALOG_NOTICES) {
    notices.push(
      `The host answered ${dialogs.length - MAX_DIALOG_NOTICES} more dialogs the same way.`
    );
  }
  for (const tab of record.tabs) {
    if (!tab.blocked) continue;
    const where = tab.blocked.url ? ` (${tab.blocked.url})` : "";
    notices.push(
      `The tab ${tab.targetId}${where} isn't responding, probably because of a dialog that opened between runs, which can't be answered now. Its page commands time out until you send Page.reload to it or navigate it.`
    );
  }
  return notices;
}

function dialogEffect(dialog: BrowserObservedDialog): string {
  if (dialog.type === "confirm") return ", so confirm() returned false";
  if (dialog.type === "prompt") return ", so prompt() returned null";
  return "";
}

/** Append `entry`, dropping the oldest entries past `limit`. */
function keepLast<T>(
  entries: T[],
  entry: T,
  limit = MAX_OBSERVED_ENTRIES_PER_TAB
): void {
  entries.push(entry);
  if (entries.length > limit) entries.splice(0, entries.length - limit);
}

function mainFrameOf(result: unknown): { id: string; url: string } | undefined {
  const frame = asRecord(asRecord(asRecord(result)?.frameTree)?.frame);
  if (typeof frame?.id !== "string" || typeof frame.url !== "string") {
    return undefined;
  }
  return { id: frame.id, url: frame.url };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
