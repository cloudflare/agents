/**
 * `HostObserver`: the host's own CDP connection to a session's browser, the
 * code that runs on it in each tab, and the record of what it saw.
 *
 * A `BrowserSession` opens one beside the model's connection
 * (`BrowserConnection.hostObserver`, opened at the same time as the model's
 * socket). It attaches to each tab the session attaches the model to, and
 * runs its per-tab watchers there: the SDK's built-ins first (dialog
 * answering), then the developer's `hostObserver` hook, if any. Built-ins
 * register first, so they hear each event first. It also enables Page and
 * Network there and keeps a small record per tab: where the tab went, what
 * each main document returned, and which dialogs were answered. The
 * session reads the record and the notices when it closes.
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
 * session goes on without it and the record says so. It follows page
 * targets only.
 */

import {
  CdpTimeoutError,
  type CdpConnection,
  type CdpEvent,
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

/** Notices a hook can add per session, with `notify()`. */
const MAX_HOOK_NOTICES = 20;

/** The longest notice a hook can add; longer ones are cut. */
const MAX_HOOK_NOTICE_LENGTH = 1_000;

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
    options?: { timeoutMs?: number }
  ): Promise<unknown>;
  /**
   * Listen for this tab's `method` events, and return a function that
   * stops listening. Enable the domain first (`tab.send("Network.enable")`):
   * the SDK enables only what its built-ins need. Handlers run as
   * `CdpConnection.on` runs them; one that throws is logged.
   */
  on(method: string, handler: (event: CdpEvent) => void): () => void;
  /** Wait for this tab's next `method` event, as `CdpConnection.waitFor`. */
  waitFor(
    method: string,
    options?: Omit<CdpWaitForOptions, "sessionId">
  ): Promise<CdpEvent>;
  /**
   * Add a sentence to the notices the model gets when the session closes,
   * after the SDK's own. Up to 20 per session, each cut to 1,000
   * characters. Ignored once the notices are collected.
   */
  notify(notice: string): void;
  /** The host's connection, for browser-level commands and events. */
  readonly cdp: CdpConnection;
  /** The host's CDP session id on this tab, valid on {@link cdp} only. */
  readonly sessionId: string;
}

/**
 * Your code on the host's CDP connection: runs once per tab a
 * `BrowserSession` works in, with that tab. It may return a cleanup, which
 * runs when the session closes, while the connection is still open.
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
   * The tab didn't answer the observer's setup, nor its last command at
   * close, while the browser did: probably a dialog that opened before the
   * host could answer it, which nobody can answer now. Page commands in it
   * time out until it's reloaded or navigated. `url` is where it was.
   */
  blocked?: { url?: string };
}

/**
 * What a session's observer saw, or why there was nothing to see.
 *
 * `tabs` can leave out a tab the session worked in even when `available`
 * is `true`: the observer couldn't attach to it or set it up, it wasn't a
 * page, or the observer's connection closed. Read a missing tab as
 * "unknown", not as "nothing happened there".
 *
 * @experimental The shape may change before stabilizing.
 */
export type BrowserObserverRecord =
  | { available: true; tabs: BrowserObservedTab[] }
  | { available: false; reason: string };

/** What a {@link HostTabWatcher} may return: a cleanup for close. */
type HostTabCleanup = () => void | Promise<void>;

/**
 * Code that runs on the host's connection in each tab: one of the SDK's
 * built-ins, or the developer's hook. The observer calls `watch` once per
 * tab, and runs the cleanup it returns at close.
 *
 * @internal The seam built-ins plug into; developers pass a
 * {@link BrowserHostObserver}.
 */
export interface HostTabWatcher {
  /** What to call it in log messages. */
  readonly name: string;
  watch(tab: BrowserHostTab): ReturnType<BrowserHostObserver>;
  /**
   * The watcher's sentences for the model, collected at close after every
   * cleanup ran. `workedIn` is the tabs the session worked in, when known.
   */
  notices?(workedIn: ReadonlySet<string> | undefined): string[];
}

/** A dialog {@link dialogWatcher} answered. */
interface AnsweredDialog {
  targetId: string;
  type: string;
  /** Cut to 200 characters. */
  message: string;
  accepted: boolean;
}

/**
 * The SDK's dialog answering, as a watcher. On Browser Run nothing else
 * answers a page's dialog: the tab's later commands hang, whether or not
 * any session has Page enabled, and model code never gets the event. So it
 * answers each one as it opens: `alert` is accepted and `beforeunload` too,
 * so navigation goes ahead; `confirm` and `prompt` are dismissed, so the
 * host never says yes for the model. Its notices tell the model what was
 * asked and answered, and how to answer yes. `onAnswer` hears each answer.
 *
 * It needs Page enabled in the tab, which the observer's setup does.
 */
export function dialogWatcher(
  onAnswer?: (dialog: AnsweredDialog) => void
): HostTabWatcher {
  /** The first dialogs answered, enough for the notices. */
  const answered: AnsweredDialog[] = [];
  /** How many dialogs were answered per tab. */
  const counts = new Map<string, number>();
  return {
    name: "dialog answering",
    watch(tab) {
      tab.on("Page.javascriptDialogOpening", (event) => {
        const type = String(event.params.type ?? "alert");
        const accepted = type === "alert" || type === "beforeunload";
        tab
          .send(
            "Page.handleJavaScriptDialog",
            { accept: accepted },
            { timeoutMs: OBSERVER_COMMAND_TIMEOUT_MS }
          )
          // Another session on the tab may have answered first.
          .catch(() => undefined);
        const dialog: AnsweredDialog = {
          targetId: tab.targetId,
          type,
          message: String(event.params.message ?? "").slice(
            0,
            MAX_DIALOG_MESSAGE_LENGTH
          ),
          accepted
        };
        counts.set(tab.targetId, (counts.get(tab.targetId) ?? 0) + 1);
        if (answered.length < MAX_OBSERVED_ENTRIES_PER_TAB) {
          answered.push(dialog);
        }
        onAnswer?.(dialog);
      });
    },
    notices(workedIn) {
      const inSession = (targetId: string) =>
        !workedIn || workedIn.has(targetId);
      const shown = answered
        .filter((dialog) => inSession(dialog.targetId))
        .slice(0, MAX_DIALOG_NOTICES);
      let total = 0;
      for (const [targetId, count] of counts) {
        if (inSession(targetId)) total += count;
      }
      const notices = shown.map(
        (dialog) =>
          `The page opened ${dialog.type === "alert" ? "an" : "a"} ${dialog.type} dialog (${JSON.stringify(dialog.message)}), and the host ${dialog.accepted ? "accepted" : "dismissed"} it${dialogEffect(dialog)}.`
      );
      if (total > shown.length) {
        notices.push(
          `The host answered ${total - shown.length} more dialogs the same way.`
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

/** What {@link HostObserver.close} returns. */
export interface HostObserverResult {
  record: BrowserObserverRecord;
  /** Sentences for the model: the built-ins', blocked tabs, then the hook's. */
  notices: string[];
}

interface ObservedTabState {
  record: BrowserObservedTab;
  /** The main frame's id: the target id until the frame tree says otherwise. */
  mainFrameId: string;
  /** Main documents waiting for a response, by request id. */
  loading: Map<string, BrowserObservedDocument>;
}

/** A watcher started in a tab, until close runs its cleanup. */
interface RunningWatcher {
  name: string;
  targetId: string;
  /** Its cleanup, once `watch` settles; never rejects. */
  cleanup: Promise<HostTabCleanup | undefined>;
  settled: boolean;
}

type Connected = { cdp: CdpConnection } | { cdp?: undefined; reason: string };

export class HostObserver {
  readonly #ready: Promise<Connected>;
  /** Each tab's attach and setup, by target id, so a tab is attached once. */
  readonly #attaching = new Map<string, Promise<void>>();
  /**
   * Each tab's setup and its watchers' promises together, by target id:
   * what the model's first command there waits for.
   */
  readonly #holds = new Map<string, Promise<void>>();
  /** Tabs whose hold was cut off and logged, so it's logged once. */
  readonly #cutOff = new Set<string>();
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
  #closing?: Promise<HostObserverResult>;
  readonly #browserName: string;
  readonly #scope: string;

  /** Take a connection that is already opening; nothing waits for it here. */
  constructor(
    connecting: Promise<CdpConnection>,
    options: HostObserverOptions
  ) {
    this.#browserName = options.browserName;
    this.#scope = options.scope;
    this.#builtIns = [
      dialogWatcher((dialog) => {
        const tab = this.#tabs.find(
          ({ record }) => record.targetId === dialog.targetId
        );
        if (!tab) return;
        const { type, message, accepted } = dialog;
        keepLast(tab.record.dialogs, { type, message, accepted });
      })
    ];
    const { hook } = options;
    if (hook) this.#hook = { name: "hostObserver", watch: hook };
    this.#ready = this.#connect(connecting);
  }

  /**
   * Whether the observer found this tab blocked when it set it up: its
   * page commands time out until it's reloaded or navigated.
   */
  isBlocked(targetId: string): boolean {
    return this.#tabs.some(
      ({ record }) => record.targetId === targetId && record.blocked
    );
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
    if (!hold) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      hold.then(() => "ready" as const),
      new Promise<"cut off">((resolve) => {
        timeoutId = setTimeout(() => resolve("cut off"), capMs);
      })
    ]);
    clearTimeout(timeoutId);
    if (outcome === "ready" || this.#cutOff.has(targetId)) return;
    const running = this.#running.filter(
      (watcher) => watcher.targetId === targetId && !watcher.settled
    );
    // A hook that hasn't started yet, because the setup is slow, counts.
    const waitingHook =
      this.#hook &&
      !this.#running.some(
        (watcher) =>
          watcher.targetId === targetId && watcher.name === this.#hook?.name
      );
    const names = [
      ...running.map((watcher) => watcher.name),
      ...(waitingHook && this.#hook ? [this.#hook.name] : [])
    ];
    if (names.length === 0) return;
    this.#cutOff.add(targetId);
    console.warn(
      `[agents/browser] ${names.join(" and ")} hadn't finished in tab ${targetId} after ${capMs}ms for browser "${this.#browserName}", so the model's first command there went ahead. It keeps running.`
    );
  }

  /**
   * Read the record and notices, and close the connection. Waits for tab
   * setups still running, then sends one last command to each tab and
   * waits for its reply, so the events Chrome sent before it have arrived.
   * A tab that looked blocked but answers it wasn't: it was only slow.
   * Then it runs the watchers' cleanups, at most ~1 s in all, and collects
   * the notices. Never rejects; later calls resolve with the same result,
   * whose record and notices cover only the tabs in `workedIn` when given:
   * the observer may start on a tab the model then doesn't use. The hook's
   * notices are kept whichever tab they came from.
   */
  close(workedIn?: ReadonlySet<string>): Promise<HostObserverResult> {
    this.#closing ??= this.#close(workedIn);
    return this.#closing;
  }

  async #close(
    workedIn: ReadonlySet<string> | undefined
  ): Promise<HostObserverResult> {
    const connected = await this.#ready;
    if (!connected.cdp) {
      return {
        record: { available: false, reason: connected.reason },
        notices: []
      };
    }
    const { cdp } = connected;
    try {
      await Promise.allSettled(this.#attaching.values());
      await Promise.allSettled(
        [...this.#tabsBySession].map(async ([sessionId, tab]) => {
          await cdp.send("Page.getFrameTree", undefined, {
            sessionId,
            timeoutMs: OBSERVER_FLUSH_TIMEOUT_MS
          });
          // It answers: it was slow, not blocked.
          delete tab.record.blocked;
        })
      );
      await this.#cleanUp();
    } finally {
      cdp.disconnect();
    }
    const tabs = this.#tabs.filter(
      ({ record }) => !workedIn || workedIn.has(record.targetId)
    );
    const hookNotices = this.#hookNotices ?? [];
    this.#hookNotices = undefined;
    return {
      record: {
        available: true,
        tabs: tabs.map(({ record }) => structuredClone(record))
      },
      notices: [
        ...this.#builtIns.flatMap(
          (watcher) => watcher.notices?.(workedIn) ?? []
        ),
        ...blockedNotices(tabs.map(({ record }) => record)),
        ...hookNotices
      ]
    };
  }

  /**
   * Run every watcher's cleanup, waiting for a watcher still running to
   * return its cleanup first, all within {@link OBSERVER_CLEANUP_TIMEOUT_MS}.
   */
  async #cleanUp(): Promise<void> {
    if (this.#running.length === 0) return;
    const cleaning = Promise.allSettled(
      this.#running.map(async ({ name, targetId, cleanup }) => {
        const run = await cleanup;
        if (!run) return;
        try {
          await run();
        } catch (error) {
          this.#warn(`run ${name}'s cleanup in tab ${targetId}`, error);
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
    if (outcome === "timeout") {
      console.warn(
        `[agents/browser] The host observer's cleanups didn't finish within ${OBSERVER_CLEANUP_TIMEOUT_MS}ms for browser "${this.#browserName}"; closing its connection anyway.`
      );
    }
  }

  async #connect(connecting: Promise<CdpConnection>): Promise<Connected> {
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
      const reason = `the observer couldn't connect: ${errorMessage(error)}`;
      this.#warn("connect", error);
      return { reason };
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
    // Closed while connecting: close() disconnects it.
    if (!this.#closing) this.#listen(outcome);
    return { cdp: outcome };
  }

  async #attachTab(targetId: string): Promise<void> {
    const connected = await this.#ready;
    const { cdp } = connected;
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
    const tab: ObservedTabState = {
      record: { targetId, navigations: [], documents: [], dialogs: [] },
      mainFrameId: targetId,
      loading: new Map()
    };
    this.#tabsBySession.set(sessionId, tab);
    this.#tabs.push(tab);
    const hostTab = this.#hostTab(cdp, sessionId, targetId);
    // The built-ins listen before Page is enabled, so they hear its events
    // first, and from the start.
    for (const watcher of this.#builtIns) this.#start(watcher, hostTab);
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
    const errors = [page, network, frameTree].flatMap((result) =>
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
    if (this.#hook && !this.#closing) this.#start(this.#hook, hostTab);
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
        cdp.send(method, params, {
          sessionId,
          ...(options?.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs })
        }),
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
  #start(watcher: HostTabWatcher, tab: BrowserHostTab): void {
    const running: RunningWatcher = {
      name: watcher.name,
      targetId: tab.targetId,
      settled: false,
      cleanup: Promise.resolve(undefined)
    };
    const fail = (error: unknown) => {
      this.#warn(`run ${watcher.name} in tab ${tab.targetId}`, error);
      return undefined;
    };
    let result: ReturnType<BrowserHostObserver>;
    try {
      // Called now, not on a later tick, so its listeners miss nothing.
      result = watcher.watch(tab);
    } catch (error) {
      result = fail(error);
    }
    running.cleanup = Promise.resolve(result)
      .then((cleanup) => (typeof cleanup === "function" ? cleanup : undefined))
      .catch(fail)
      .finally(() => {
        running.settled = true;
      });
    this.#running.push(running);
  }

  /** Stop following a target, and leave it out of the record. */
  #forget(cdp: CdpConnection, sessionId: string, tab: ObservedTabState): void {
    this.#tabsBySession.delete(sessionId);
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
    const { targetId } = tab.record;
    try {
      const info = await cdp.send(
        "Target.getTargetInfo",
        { targetId },
        { timeoutMs: OBSERVER_SETUP_TIMEOUT_MS }
      );
      const targetInfo = asRecord(asRecord(info)?.targetInfo);
      if (targetInfo?.type === "page") {
        const { url } = targetInfo;
        tab.record.blocked = typeof url === "string" ? { url } : {};
      }
    } catch {
      // The browser doesn't answer either: not a stuck tab.
    }
    this.#warn(`set up tab ${targetId}`, setupError);
  }

  /** The record's listeners. Dialog answering is a watcher; see the constructor. */
  #listen(cdp: CdpConnection): void {
    // Each handler looks the event's session up in #tabsBySession, so it
    // ignores sessions that aren't this connection's: Browser Run tags its
    // `Cloudflare.*` events with every connection's session ids.
    cdp.on("Page.frameNavigated", (event) => {
      const tab = this.#tab(event);
      const frame = asRecord(event.params.frame);
      if (!tab || !frame || frame.parentId !== undefined) return;
      if (typeof frame.id === "string") tab.mainFrameId = frame.id;
      if (typeof frame.url !== "string") return;
      const fragment =
        typeof frame.urlFragment === "string" ? frame.urlFragment : "";
      keepLast(tab.record.navigations, { url: frame.url + fragment });
    });
    cdp.on("Page.navigatedWithinDocument", (event) => {
      const tab = this.#tab(event);
      const { frameId, url } = event.params;
      if (!tab || frameId !== tab.mainFrameId || typeof url !== "string") {
        return;
      }
      keepLast(tab.record.navigations, { url, sameDocument: true });
    });
    // Network sends an event for every request: drop all but the main
    // frame's documents on arrival.
    cdp.on("Network.requestWillBeSent", (event) => {
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
    cdp.on("Network.responseReceived", (event) => {
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
    cdp.on("Network.loadingFailed", (event) => {
      const { params } = event;
      if (params.type !== "Document") return;
      const document = this.#loading(event);
      if (!document) return;
      document.error = String(params.errorText ?? "failed");
      this.#tab(event)?.loading.delete(String(params.requestId));
    });
    cdp.on("Target.detachedFromTarget", (event) => {
      const { sessionId } = event.params;
      if (typeof sessionId === "string") this.#tabsBySession.delete(sessionId);
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

/** Tell the model about tabs a dialog left blocked, and how to recover them. */
function blockedNotices(tabs: BrowserObservedTab[]): string[] {
  return tabs.flatMap((tab) => {
    if (!tab.blocked) return [];
    const where = tab.blocked.url ? ` (${tab.blocked.url})` : "";
    return [
      `The tab ${tab.targetId}${where} isn't responding, probably because of a dialog that opened before the host could answer it, which can't be answered now. Its page commands time out until you send Page.reload to it or navigate it.`
    ];
  });
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
