/**
 * `HostObserver`: the host's own CDP connection to a session's browser, and
 * the code that runs on it in each tab.
 *
 * A `BrowserSession` opens one beside the model's connection
 * (`BrowserConnection.hostConnection`, opened at the same time as the model's
 * socket). It attaches to each tab the session attaches the model to, and
 * runs its per-tab watchers there: the SDK's built-ins first (dialog
 * answering), then the developer's `hostObserver` hook, if any. Built-ins
 * register first, so they hear each event first. It enables Page there,
 * which dialog answering needs, and notices tabs a dialog left blocked.
 * The session reads its notices for the model when it closes.
 *
 * It has its own WebSocket because Chrome keeps CDP sessions per connection:
 * model code can't address or detach the observer's sessions, its
 * `Page.disable` doesn't touch them, and the observer's commands and events
 * never reach the model's debug log. (Browser Run's `Cloudflare.*` events are
 * the exception: they arrive on every connection, tagged with every
 * connection's session ids, so the model's debug log can record the
 * observer's session id. That's harmless: the id doesn't work on the model's
 * socket.) What it does is still advice, not enforcement: the model can
 * close the tab or block requests.
 *
 * It never fails a run. The model's first command to each tab waits for the
 * observer's setup and the watchers there, at most ~250 ms, so they hear
 * the first navigation; later commands never wait. A watcher that throws is
 * logged. If it can't connect in time, or a tab can't be observed, the
 * session goes on without it, and the failure to connect is logged. It
 * follows page targets only.
 */

import type { Protocol } from "devtools-protocol";
import {
  CdpProtocolError,
  CdpTimeoutError,
  type CdpConnection,
  type CdpEvent,
  type CdpEventHandler,
  type CdpEventMethod,
  type CdpSendOptions,
  type CdpWaitForOptions
} from "./cdp-connection";

/**
 * The longest the model's first command to a tab waits for the observer to
 * finish setting up there, the developer's hook included.
 */
export const OBSERVER_FIRST_COMMAND_WAIT_MS = 250;

/** How long a session waits for its observer to connect before going on without it. */
export const OBSERVER_CONNECT_TIMEOUT_MS = 2_000;

/**
 * The longest a session's close waits for the watchers' cleanups, all of
 * them together, before it closes the connection anyway.
 */
export const OBSERVER_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * The limit on each command that sets up a tab. Short, because a tab left
 * blocked by a dialog never answers them.
 */
const OBSERVER_SETUP_TIMEOUT_MS = 1_000;

/** The limit on the observer's other commands. */
const OBSERVER_COMMAND_TIMEOUT_MS = 2_000;

/** The limit on the last command per tab before the notices are read. */
const OBSERVER_FLUSH_TIMEOUT_MS = 1_000;

/** Answered dialogs kept per session for the notices; later ones are only counted. */
const MAX_ANSWERED_DIALOGS_KEPT = 50;

/** The longest dialog message kept. */
const MAX_DIALOG_MESSAGE_LENGTH = 200;

/** Dialog notices given to the model per session. */
const MAX_DIALOG_NOTICES = 5;

/**
 * Notices a hook can add per session, with `notify()`. Small, so a hook
 * that misbehaves can't push the SDK's own notices out of a runner's
 * output tail (Computer keeps the last 16 KiB of stderr).
 */
const MAX_HOOK_NOTICES = 10;

/** The longest notice a hook can add; longer ones are cut. */
const MAX_HOOK_NOTICE_LENGTH = 500;

/**
 * One tab, as the developer's {@link BrowserHostObserver} sees it: the
 * host's own CDP session on it, on the host's connection. Model code can't
 * reach it.
 *
 * @experimental May change before stabilizing.
 */
export interface BrowserHostTab {
  /** The tab's CDP target id. */
  readonly targetId: string;
  /** The scope of the session working in it. */
  readonly scope: string;
  /**
   * Send a command to this tab on the host's connection. Without
   * `timeoutMs`, the `Browser`'s command timeout applies.
   */
  send(
    method: string,
    params?: unknown,
    options?: Omit<CdpSendOptions, "sessionId">
  ): Promise<unknown>;
  /**
   * Listen for this tab's `method` events, and return a function that
   * stops listening. Enable the domain first (`tab.send("Network.enable")`):
   * the SDK enables only what its built-ins need. Handlers run as
   * `CdpConnection.on` runs them; one that throws is logged. The event is
   * typed for `method`, as there.
   */
  on<M extends CdpEventMethod>(
    method: M,
    handler: CdpEventHandler<M>
  ): () => void;
  /**
   * Wait for this tab's next `method` event, as `CdpConnection.waitFor`.
   * One still waiting when the session closes rejects, for code that
   * awaits it; one nothing awaits isn't an unhandled rejection.
   */
  waitFor<M extends CdpEventMethod>(
    method: M,
    options?: Omit<CdpWaitForOptions<M>, "sessionId">
  ): Promise<CdpEvent<M>>;
  /**
   * Add a sentence to the notices the model gets when the session closes,
   * after the SDK's own. Up to 10 per session, each cut to 500
   * characters. Ignored once the notices are collected. The model reads it
   * as the host speaking, so quote any text the page controls.
   */
  notify(notice: string): void;
  /**
   * The host's connection, for browser-level commands and events. Don't
   * answer dialogs from a listener on it: the SDK answers them first.
   */
  readonly cdp: CdpConnection;
  /**
   * The host's CDP session id on this tab, valid on {@link cdp} only. Not
   * `cdp.sessionId`, which is the Browser Run session's id.
   */
  readonly sessionId: string;
}

/**
 * Your code on the host's CDP connection: runs once per tab a
 * `BrowserSession` works in, with that tab. It may return a cleanup, which
 * runs when the session closes, while the connection is still open. A
 * cleanup returned more than ~1 s into the close isn't run.
 *
 * The model's first command to the tab waits for it (and its promise), at
 * most 250 ms; after that the model goes ahead and it keeps running. A hook
 * or cleanup that throws or rejects is logged and never fails the run. It
 * isn't called when the host's connection couldn't open.
 *
 * @experimental May change before stabilizing.
 */
export type BrowserHostObserver = (
  tab: BrowserHostTab
) =>
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>;

/** What a {@link HostTabWatcher} may return: a cleanup for close. */
type HostTabCleanup = () => void | Promise<void>;

/**
 * Code that runs on the host's connection: one of the SDK's built-ins, or
 * the developer's hook. The observer calls `connect` once, when the
 * connection opens, and `watch` once per tab, and runs the cleanup `watch`
 * returns at close.
 *
 * @internal The seam built-ins plug into; developers pass a
 * {@link BrowserHostObserver}.
 */
export interface HostTabWatcher {
  /** What to call it in log messages. */
  readonly name: string;
  /**
   * Set up on the connection, before any tab is attached, so its listeners
   * are ahead of any the hook adds, even raw ones on `tab.cdp`. `tabOf`
   * finds the tab an event came from, or `undefined` for events from
   * sessions that aren't this connection's tabs.
   */
  connect?(
    cdp: CdpConnection,
    tabOf: (event: CdpEvent) => BrowserHostTab | undefined
  ): void;
  /** Set up in one tab, once Page is about to be enabled there. */
  watch?(tab: BrowserHostTab): ReturnType<BrowserHostObserver>;
  /**
   * The watcher's sentences for the model, collected at close after every
   * cleanup ran. `workedIn` is the tabs the session worked in, when known.
   */
  notices?(workedIn: ReadonlySet<string> | undefined): string[];
}

/** A dialog {@link dialogWatcher} answered. */
interface AnsweredDialog {
  targetId: string;
  type: Protocol.Page.DialogType;
  /** Cut to 200 characters. */
  message: string;
  accepted: boolean;
  /** Chrome refused the answer: someone else answered it first. */
  refused?: boolean;
}

/**
 * The SDK's dialog answering, as a watcher. On Browser Run nothing else
 * answers a page's dialog: the tab's later commands hang, whether or not
 * any session has Page enabled, and model code never gets the event. So it
 * answers each one as it opens: `alert` is accepted and `beforeunload` too,
 * so navigation goes ahead; `confirm` and `prompt` are dismissed, so the
 * host never says yes for the model. Its notices tell the model what was
 * asked and answered, and how to answer yes.
 *
 * It listens once per connection, before the hook can add a listener, so
 * it answers first even when the hook listens on the raw connection. It
 * needs Page enabled in the tab, which the observer's setup does. A dialog
 * someone else answered first (model code that enabled Page and answered
 * it, say) isn't in the notices: Chrome refuses the host's answer.
 */
export function dialogWatcher(): HostTabWatcher {
  /** The first dialogs answered, enough for the notices. */
  const answered: AnsweredDialog[] = [];
  /** How many dialogs were answered per tab. */
  const counts = new Map<string, number>();
  return {
    name: "dialog answering",
    connect(cdp, tabOf) {
      cdp.on("Page.javascriptDialogOpening", (event) => {
        const tab = tabOf(event);
        if (!tab) return;
        const { type, message } = event.params;
        const accepted = type === "alert" || type === "beforeunload";
        // Kept now, so the notices list dialogs in the order they opened.
        const dialog: AnsweredDialog = {
          targetId: tab.targetId,
          type,
          message: message.slice(0, MAX_DIALOG_MESSAGE_LENGTH),
          accepted
        };
        counts.set(tab.targetId, (counts.get(tab.targetId) ?? 0) + 1);
        if (answered.length < MAX_ANSWERED_DIALOGS_KEPT) {
          answered.push(dialog);
        }
        tab
          .send(
            "Page.handleJavaScriptDialog",
            { accept: accepted },
            { timeoutMs: OBSERVER_COMMAND_TIMEOUT_MS }
          )
          .catch((error: unknown) => {
            // Another session on the tab answered first, so the host's
            // answer isn't what the page got. A timeout means the tab
            // hung, and the host did send it, so that one stays.
            if (!(error instanceof CdpProtocolError)) return;
            dialog.refused = true;
            counts.set(tab.targetId, (counts.get(tab.targetId) ?? 1) - 1);
          });
      });
    },
    notices(workedIn) {
      const inSession = (targetId: string) =>
        !workedIn || workedIn.has(targetId);
      const shown = answered
        .filter((dialog) => !dialog.refused && inSession(dialog.targetId))
        .slice(0, MAX_DIALOG_NOTICES);
      let total = 0;
      for (const [targetId, count] of counts) {
        if (inSession(targetId)) total += count;
      }
      const notices = shown.map(
        (dialog) =>
          `The page opened ${dialog.type === "alert" ? "an" : "a"} ${dialog.type} dialog (${JSON.stringify(dialog.message)}), and the host ${dialog.accepted ? "accepted" : "dismissed"} it${dialogEffect(dialog)}.`
      );
      const more = total - shown.length;
      if (more > 0) {
        notices.push(
          `The host answered ${more} more ${more === 1 ? "dialog" : "dialogs"} the same way.`
        );
      }
      return notices;
    }
  };
}

function dialogEffect(dialog: AnsweredDialog): string {
  if (dialog.type === "confirm") {
    return ", so confirm() returned false. To answer OK, set `window.confirm = () => true` in the page before the step that opens it";
  }
  if (dialog.type === "prompt") {
    return ', so prompt() returned null. To answer it, set `window.prompt = () => "<answer>"` in the page before the step that opens it';
  }
  return "";
}

/** {@link HostObserver}'s options. */
export interface HostObserverOptions {
  /** The browser's name, for log messages. */
  browserName: string;
  /** The session's scope, for {@link BrowserHostTab.scope}. */
  scope: string;
  /** The developer's hook, run in each tab after the built-ins. */
  hook?: BrowserHostObserver | undefined;
}

interface ObservedTabState {
  targetId: string;
  /**
   * The tab didn't answer the observer's setup, while the browser did:
   * probably a dialog that opened before the host could answer it, which
   * nobody can answer now. Page commands in it time out until it's
   * reloaded or navigated. `url` is where it was. Cleared when the tab
   * answers at close after all.
   */
  blocked?: { url?: string };
}

/** A watcher started in a tab, until close runs its cleanup. */
interface RunningWatcher {
  name: string;
  targetId: string;
  /** Its cleanup, once `watch` settles; never rejects. */
  cleanup: Promise<HostTabCleanup | undefined>;
  /** `watching` until `watch` settles, `cleaning` while its cleanup runs. */
  state: "watching" | "watched" | "cleaning" | "done";
}

export class HostObserver {
  /** The connection, or `undefined` when it couldn't open in time. */
  readonly #ready: Promise<CdpConnection | undefined>;
  /** Each tab's attach and setup, by target id, so a tab is attached once. */
  readonly #attaching = new Map<string, Promise<void>>();
  /**
   * Each tab's setup and its watchers' promises together, by target id:
   * what the model's first command there waits for.
   */
  readonly #holds = new Map<string, Promise<void>>();
  /**
   * Tabs whose hold the cap cut off: later holds there return at once, and
   * the warning is logged once.
   */
  readonly #cutOff = new Set<string>();
  /** The tab objects, by the observer's CDP session id. */
  readonly #hostTabs = new Map<string, BrowserHostTab>();
  /** Set once close stops waiting for cleanups: later ones don't run. */
  #cleanupsOver = false;
  /** Observed tabs, by the observer's CDP session id. */
  readonly #tabsBySession = new Map<string, ObservedTabState>();
  /** Observed tabs in the order they were attached. */
  readonly #tabs: ObservedTabState[] = [];
  /** The SDK's own watchers, run in each tab before the hook. */
  readonly #builtIns: HostTabWatcher[];
  /** The developer's hook, as a watcher. */
  readonly #hook?: HostTabWatcher;
  /** Every watcher started, in order. */
  readonly #running: RunningWatcher[] = [];
  /** What the hook passed to `notify()`; `undefined` once collected. */
  #hookNotices?: string[] = [];
  /** Whether the hook passed too many notices, which was logged. */
  #droppedNotices = false;
  #closing?: Promise<string[]>;
  readonly #browserName: string;
  readonly #scope: string;

  /** Take a connection that is already opening; nothing waits for it here. */
  constructor(
    connecting: Promise<CdpConnection>,
    options: HostObserverOptions
  ) {
    this.#browserName = options.browserName;
    this.#scope = options.scope;
    this.#builtIns = [dialogWatcher()];
    const { hook } = options;
    if (hook) this.#hook = { name: "hostObserver", watch: hook };
    this.#ready = this.#connect(connecting);
  }

  /**
   * Whether the observer found this tab blocked when it set it up: its
   * page commands time out until it's reloaded or navigated.
   */
  isBlocked(targetId: string): boolean {
    return this.#tabs.some((tab) => tab.targetId === targetId && tab.blocked);
  }

  /**
   * Start observing a tab: one the session is about to attach the model
   * to, or just did. Returns at once; {@link ready} waits for the setup.
   */
  attach(targetId: string): void {
    if (this.#closing || this.#attaching.has(targetId)) return;
    const attaching = this.#attachTab(targetId);
    this.#attaching.set(targetId, attaching);
    this.#holds.set(
      targetId,
      attaching.then(() =>
        Promise.allSettled(
          this.#running
            .filter((running) => running.targetId === targetId)
            .map((running) => running.cleanup)
        ).then(() => undefined)
      )
    );
  }

  /**
   * Wait for the observer's setup in a tab and its watchers there, at most
   * `capMs`, before the model's first command there, so they hear what it
   * does. Resolves at once for a tab it isn't setting up; never rejects.
   * Logs when the cap cut a watcher off: it keeps running.
   */
  async ready(
    targetId: string,
    capMs = OBSERVER_FIRST_COMMAND_WAIT_MS
  ): Promise<void> {
    const hold = this.#holds.get(targetId);
    if (!hold || this.#cutOff.has(targetId)) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      hold.then(() => "ready" as const),
      new Promise<"cut off">((resolve) => {
        timeoutId = setTimeout(() => resolve("cut off"), capMs);
      })
    ]);
    clearTimeout(timeoutId);
    if (outcome === "ready" || this.#cutOff.has(targetId)) return;
    this.#cutOff.add(targetId);
    const unfinished = this.#running.filter(
      (watcher) => watcher.targetId === targetId && watcher.state === "watching"
    );
    const hookStarted = this.#running.some(
      (watcher) =>
        watcher.targetId === targetId && watcher.name === this.#hook?.name
    );
    if (unfinished.length > 0) {
      const names = unfinished.map((watcher) => watcher.name).join(" and ");
      console.warn(
        `[agents/browser] ${names} hadn't finished in tab ${targetId} after ${capMs}ms for browser "${this.#browserName}", so the model's first command there went ahead. It keeps running.`
      );
    } else if (this.#hook && !hookStarted) {
      // The SDK's setup is what's slow: the hook hasn't been called.
      console.warn(
        `[agents/browser] The host connection wasn't set up in tab ${targetId} after ${capMs}ms for browser "${this.#browserName}", so the model's first command there went ahead before hostObserver was called.`
      );
    }
  }

  /**
   * Collect the notices for the model, and close the connection. Waits for tab
   * setups still running, then sends one last command to each tab and
   * waits for its reply, so the events Chrome sent before it have arrived.
   * A tab that looked blocked but answers it wasn't: it was only slow.
   * Then it runs the watchers' cleanups, at most ~1 s in all, closes the
   * connection, and collects the notices: the built-ins', blocked tabs,
   * then the hook's. Never
   * rejects; later calls resolve with the same notices. The SDK's notices
   * cover only the tabs in `workedIn` when given: the observer may start
   * on a tab the model then doesn't use. The hook's are kept whichever tab
   * they came from.
   */
  close(workedIn?: ReadonlySet<string>): Promise<string[]> {
    this.#closing ??= this.#close(workedIn);
    return this.#closing;
  }

  async #close(workedIn: ReadonlySet<string> | undefined): Promise<string[]> {
    const cdp = await this.#ready;
    if (!cdp) return [];
    try {
      await Promise.allSettled(this.#attaching.values());
      await Promise.allSettled(
        [...this.#tabsBySession].map(async ([sessionId, tab]) => {
          await cdp.send("Page.getFrameTree", undefined, {
            sessionId,
            timeoutMs: OBSERVER_FLUSH_TIMEOUT_MS
          });
          // It answers: it was slow, not blocked.
          delete tab.blocked;
        })
      );
      await this.#cleanUp();
    } finally {
      cdp.disconnect();
    }
    const tabs = this.#tabs.filter(
      ({ targetId }) => !workedIn || workedIn.has(targetId)
    );
    const hookNotices = this.#hookNotices ?? [];
    this.#hookNotices = undefined;
    return [
      ...this.#builtIns.flatMap((watcher) => watcher.notices?.(workedIn) ?? []),
      ...blockedNotices(tabs),
      ...hookNotices
    ];
  }

  /**
   * Run every watcher's cleanup, waiting for a watcher still running to
   * return its cleanup first, all within {@link OBSERVER_CLEANUP_TIMEOUT_MS}.
   * A cleanup returned after that isn't run: the connection is closing.
   */
  async #cleanUp(): Promise<void> {
    if (this.#running.length === 0) return;
    const cleaning = Promise.allSettled(
      this.#running.map(async (running) => {
        const { name, targetId, cleanup } = running;
        const run = await cleanup;
        if (!run || this.#cleanupsOver) return;
        running.state = "cleaning";
        try {
          await run();
        } catch (error) {
          this.#warn(`run ${name}'s cleanup in tab ${targetId}`, error);
        } finally {
          running.state = "done";
        }
      })
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      cleaning.then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(
          () => resolve("timeout"),
          OBSERVER_CLEANUP_TIMEOUT_MS
        );
      })
    ]);
    clearTimeout(timeoutId);
    this.#cleanupsOver = true;
    if (outcome === "timeout") {
      const pending = this.#running.flatMap(({ name, targetId, state }) => {
        if (state === "watching") {
          return [
            `${name} in tab ${targetId} (still running, so its cleanup won't run)`
          ];
        }
        if (state === "cleaning")
          return [`${name}'s cleanup in tab ${targetId}`];
        return [];
      });
      console.warn(
        `[agents/browser] The host observer's cleanups didn't finish within ${OBSERVER_CLEANUP_TIMEOUT_MS}ms for browser "${this.#browserName}": ${pending.join(", ")}. Closing its connection anyway.`
      );
    }
  }

  /** Wait for the connection, at most {@link OBSERVER_CONNECT_TIMEOUT_MS}; log a failure. */
  async #connect(
    connecting: Promise<CdpConnection>
  ): Promise<CdpConnection | undefined> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(
        () => resolve("timeout"),
        OBSERVER_CONNECT_TIMEOUT_MS
      );
    });
    let outcome: CdpConnection | "timeout";
    try {
      outcome = await Promise.race([connecting, timedOut]);
    } catch (error) {
      this.#warn("connect", error);
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
    if (outcome === "timeout") {
      this.#warn(
        "connect",
        new Error(
          `the observer didn't connect within ${OBSERVER_CONNECT_TIMEOUT_MS}ms`
        )
      );
      // Drop the connection if it arrives late.
      connecting.then(
        (late) => late.disconnect(),
        () => undefined
      );
      return undefined;
    }
    // Closed while connecting: close() disconnects it.
    if (!this.#closing) this.#listen(outcome);
    return outcome;
  }

  async #attachTab(targetId: string): Promise<void> {
    const cdp = await this.#ready;
    if (!cdp || this.#closing) return;
    let sessionId: string;
    try {
      sessionId = await cdp.attachToTarget(targetId, {
        timeoutMs: OBSERVER_COMMAND_TIMEOUT_MS
      });
    } catch (error) {
      // An unknown target id is the model's to hear about, not the host's.
      if (error instanceof CdpTimeoutError) {
        this.#warn(`attach to tab ${targetId}`, error);
      }
      return;
    }
    const tab: ObservedTabState = { targetId };
    this.#tabsBySession.set(sessionId, tab);
    this.#tabs.push(tab);
    const hostTab = this.#hostTab(cdp, sessionId, targetId);
    // Known before Page is enabled, so the built-ins' connection listeners
    // route its first events to it.
    this.#hostTabs.set(sessionId, hostTab);
    for (const watcher of this.#builtIns) {
      if (watcher.watch) this.#start(watcher, watcher.watch, hostTab);
    }
    const send = (method: string, params?: unknown) =>
      cdp.send(method, params, {
        sessionId,
        timeoutMs: OBSERVER_SETUP_TIMEOUT_MS
      });
    // Page.enable is what dialog answering needs. Behind an open dialog it
    // times out, and so does Page.getFrameTree, either of which flags the
    // tab blocked. The frame tree is also the flush command at close; sent
    // together, it costs no extra round trip.
    const results = await Promise.allSettled([
      send("Page.enable"),
      send("Page.getFrameTree")
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : []
    );
    if (errors.some((error) => !(error instanceof CdpTimeoutError))) {
      // The target answered, but not as a page does (a worker, say):
      // stop following it, and don't call the hook there.
      this.#forget(cdp, sessionId, tab);
      return;
    }
    if (errors.length > 0) {
      await this.#checkBlocked(cdp, tab, errors[0]);
    }
    // The hook runs once the tab is known to be a page. Not once the
    // session is closing: nothing would hear what it set up.
    const hook = this.#hook;
    if (hook?.watch && !this.#closing) this.#start(hook, hook.watch, hostTab);
  }

  /** The tab object watchers get, bound to the host's session on it. */
  #hostTab(
    cdp: CdpConnection,
    sessionId: string,
    targetId: string
  ): BrowserHostTab {
    return {
      targetId,
      scope: this.#scope,
      cdp,
      sessionId,
      send: (method, params, options) =>
        cdp.send(method, params, { ...options, sessionId }),
      on: (method, handler) => cdp.on(method, handler, { sessionId }),
      waitFor: (method, options) =>
        cdp.waitFor(method, { ...options, sessionId }),
      notify: (notice) => this.#notify(notice)
    };
  }

  #notify(notice: string): void {
    const notices = this.#hookNotices;
    if (!notices) return;
    const text = String(notice).trim().slice(0, MAX_HOOK_NOTICE_LENGTH);
    if (text === "") return;
    if (notices.length < MAX_HOOK_NOTICES) {
      notices.push(text);
      return;
    }
    if (this.#droppedNotices) return;
    this.#droppedNotices = true;
    console.warn(
      `[agents/browser] The host observer added more than ${MAX_HOOK_NOTICES} notices for browser "${this.#browserName}"; dropping the rest.`
    );
  }

  /**
   * Call a watcher in a tab, and keep its cleanup for close. A watcher
   * that throws or rejects is logged.
   */
  #start(
    watcher: HostTabWatcher,
    watch: NonNullable<HostTabWatcher["watch"]>,
    tab: BrowserHostTab
  ): void {
    const running: RunningWatcher = {
      name: watcher.name,
      targetId: tab.targetId,
      state: "watching",
      cleanup: Promise.resolve(undefined)
    };
    const fail = (error: unknown) => {
      this.#warn(`run ${watcher.name} in tab ${tab.targetId}`, error);
      return undefined;
    };
    let result: ReturnType<BrowserHostObserver>;
    try {
      // Called now, not on a later tick, so its listeners miss nothing.
      result = watch(tab);
    } catch (error) {
      result = fail(error);
    }
    running.cleanup = Promise.resolve(result)
      .then((cleanup) => (typeof cleanup === "function" ? cleanup : undefined))
      .catch(fail)
      .finally(() => {
        if (running.state === "watching") running.state = "watched";
      });
    this.#running.push(running);
  }

  /** Stop following a target. */
  #forget(cdp: CdpConnection, sessionId: string, tab: ObservedTabState): void {
    this.#tabsBySession.delete(sessionId);
    this.#hostTabs.delete(sessionId);
    this.#tabs.splice(this.#tabs.indexOf(tab), 1);
    cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  /**
   * The tab's setup timed out. If the browser still answers for it and it
   * is a page, it looks blocked, most likely by a dialog that opened before
   * the host could answer it: only a session with Page enabled before a
   * dialog opens can answer it. Recovering means reloading or navigating
   * the tab, which is left to the model. {@link close} checks again.
   */
  async #checkBlocked(
    cdp: CdpConnection,
    tab: ObservedTabState,
    setupError: unknown
  ): Promise<void> {
    const { targetId } = tab;
    try {
      const info = await cdp.send(
        "Target.getTargetInfo",
        { targetId },
        { timeoutMs: OBSERVER_SETUP_TIMEOUT_MS }
      );
      const targetInfo = asRecord(asRecord(info)?.targetInfo);
      if (targetInfo?.type === "page") {
        const { url } = targetInfo;
        tab.blocked = typeof url === "string" ? { url } : {};
      }
    } catch {
      // The browser doesn't answer either: not a stuck tab.
    }
    this.#warn(`set up tab ${targetId}`, setupError);
  }

  /**
   * The connection's own listeners, before any tab is attached: the
   * built-ins' `connect`, then tab detaches.
   */
  #listen(cdp: CdpConnection): void {
    // Looked up by session id, so events Browser Run tags with another
    // connection's session ids are ignored.
    const tabOf = (event: CdpEvent) =>
      event.sessionId === undefined
        ? undefined
        : this.#hostTabs.get(event.sessionId);
    for (const watcher of this.#builtIns) watcher.connect?.(cdp, tabOf);
    // A tab that closed, or whose session ended: nothing to flush at close,
    // and a tab the model closed isn't blocked any more.
    cdp.on("Target.detachedFromTarget", (event) => {
      const { sessionId } = event.params;
      const tab = this.#tabsBySession.get(sessionId);
      if (tab) delete tab.blocked;
      this.#tabsBySession.delete(sessionId);
    });
  }

  #warn(action: string, error: unknown): void {
    console.warn(
      `[agents/browser] The observer failed to ${action} for browser "${this.#browserName}"`,
      error
    );
  }
}

/** Tell the model about tabs a dialog left blocked, and how to recover them. */
function blockedNotices(tabs: ObservedTabState[]): string[] {
  return tabs.flatMap((tab) => {
    if (!tab.blocked) return [];
    const where = tab.blocked.url ? ` (${tab.blocked.url})` : "";
    return [
      `The tab ${tab.targetId}${where} isn't responding, probably because of a dialog that opened before the host could answer it, which can't be answered now. Its page commands time out until you send Page.reload to it or navigate it.`
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
