/**
 * The browser-sessions Lifecycle capability: agents wiring for the
 * provider-independent named-session core in `./session-core`.
 *
 * Install it with `Lifecycle.use()` — on an Agent subclass or any plain
 * Durable Object that composes `Lifecycle` — and it supplies what the bare
 * core leaves to hosts:
 *
 * - a durable session store over the object's own storage (unless the host
 *   wires a custom {@link BrowserSessionStore}),
 * - the recurring idle sweep, scheduled through Lifecycle's alarm-backed job
 *   queue only while named sessions (or their tombstones) exist,
 * - host-only observability: {@link BrowserSessions.sessions} and
 *   {@link BrowserSessions.liveView}.
 *
 * Everything here is host-side. Models never see session names, Browser Run
 * ids, or Live View URLs through this surface.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import {
  isMissingBrowserSession,
  listBrowserTargets,
  type BrowserBinding
} from "./browser-run";
import {
  mintLiveView,
  type BrowserLiveView,
  type LiveViewMode
} from "./live-view";
import {
  DEFAULT_BROWSER_SESSION_NAME,
  NamedBrowserSessions,
  namedBrowserSessionKey,
  type BrowserSessionCreateOptions,
  type BrowserSessionSweepResult,
  type ConnectedBrowserSession,
  type ResolvedBrowserSession
} from "./session-core";
import {
  DEFAULT_SWEEP_IDLE_MS,
  DurableBrowserSessionStore,
  type BrowserSessionStore
} from "./session-manager";

/**
 * The sweep's job id (and `fn`). Namespaced because `cf_agents_jobs` keys
 * ids globally — a cross-owner collision throws — and short generic ids like
 * `"sweep"` are exactly what hosts pick for their own jobs.
 *
 * @internal Exported for tests.
 */
export const BROWSER_SWEEP_JOB_ID = "browser-sessions:sweep";

export interface BrowserSessionsOptions {
  /** The Browser Rendering binding sessions are created against. */
  browser: BrowserBinding;
  /**
   * Session store. Defaults to a {@link DurableBrowserSessionStore} over the
   * host object's own storage. A custom store without `list` disables the
   * automatic sweep and `sessions()` — such hosts sweep manually.
   */
  store?: BrowserSessionStore;
  /** Durable creation options reapplied on every create (incl. restarts). */
  create?: BrowserSessionCreateOptions;
  /** Default CDP command timeout for {@link BrowserSessions.connect}. */
  timeoutMs?: number;
  /**
   * Idle window before the sweep closes a session (and prunes its
   * tombstone), and the sweep's own cadence. Defaults to
   * {@link DEFAULT_SWEEP_IDLE_MS} (10 minutes).
   */
  sweepIdleMs?: number;
}

/** One named session as the host sees it. Never expose this to models. */
export interface BrowserSessionView {
  name: string;
  /** `"live"` until closed or swept; tombstones list as `"closed"`. */
  status: "live" | "closed";
  createdAt: number;
  updatedAt: number;
  /** The Browser Run session id — host-side only. */
  sessionId: string;
}

/**
 * Named browser sessions as a Lifecycle capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class BrowserSessions extends LifecycleCapability {
  readonly #options: BrowserSessionsOptions;
  readonly #sweepIdleMs: number;
  #store?: BrowserSessionStore;
  #core?: NamedBrowserSessions;

  constructor(options: BrowserSessionsOptions) {
    super("browser");
    this.#options = options;
    this.#sweepIdleMs = options.sweepIdleMs ?? DEFAULT_SWEEP_IDLE_MS;
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /**
   * Crash recovery: sessions can exist without a pending sweep job when a
   * prior life died between the store write and the job push. Jobs are
   * durable, so in every ordinary life the pending job is already there.
   */
  override async onStart(): Promise<void> {
    if (this.lifecycle.jobs.get(BROWSER_SWEEP_JOB_ID)) {
      // The row is durable but the physical alarm may not be: a prior life
      // can die between the row write and `setAlarm`. Like Scheduler and
      // Tasks, recover it explicitly (deferred until startup completes).
      await this.lifecycle.jobs.rearm();
      return;
    }
    const entries = await this.#sessionStore.list?.(namedBrowserSessionKey(""));
    if (entries && entries.size > 0) await this.#armSweep();
  }

  /**
   * The recurring sweep: close idle sessions, prune aged tombstones, and
   * keep itself scheduled only while there is anything left to watch — an
   * object with no browser sessions carries no recurring alarm.
   */
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== BROWSER_SWEEP_JOB_ID) return undefined;
    await this.#core_().sweep();
    const entries = await this.#sessionStore.list?.(namedBrowserSessionKey(""));
    if (entries && entries.size > 0) {
      return { rescheduleAt: Date.now() + this.#sweepIdleMs };
    }
    return undefined;
  }

  /**
   * A sweep that still fails after Lifecycle's in-process retries must not
   * retire the recurring job while sessions may remain — completion is the
   * driver's default for unobserved terminal failures. Reschedule one idle
   * window out; the next healthy dispatch resumes the normal cadence.
   */
  async onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== BROWSER_SWEEP_JOB_ID) return undefined;
    console.warn(
      `Browser session sweep failed terminally after ${context.attempt} ` +
        "attempt(s); rescheduling",
      error
    );
    return { rescheduleAt: Date.now() + this.#sweepIdleMs };
  }

  // ── Session surface ──────────────────────────────────────────────────────

  /**
   * Resolve the named session — reattach-or-create with loud mortality
   * signaling. See {@link ResolvedBrowserSession.restarted}.
   */
  async resolve(
    name = DEFAULT_BROWSER_SESSION_NAME
  ): Promise<ResolvedBrowserSession> {
    const resolved = await this.#core_().resolve(name);
    await this.#scheduleSweep();
    return resolved;
  }

  /** Resolve the named session and attach a CDP socket to it. */
  async connect(
    name = DEFAULT_BROWSER_SESSION_NAME
  ): Promise<ConnectedBrowserSession> {
    const connected = await this.#core_().connect(name);
    await this.#scheduleSweep();
    return connected;
  }

  /**
   * Close the named session, leaving the tombstone that makes the next
   * resolve report `restarted: true`.
   */
  async close(name = DEFAULT_BROWSER_SESSION_NAME): Promise<boolean> {
    const closed = await this.#core_().close(name);
    if (closed) await this.#scheduleSweep();
    return closed;
  }

  /** Run one sweep now, besides the scheduled cadence. */
  sweep(): Promise<BrowserSessionSweepResult> {
    return this.#core_().sweep();
  }

  // ── Host observability ───────────────────────────────────────────────────

  /**
   * Every named session on record, tombstones included, ordered by name.
   * Empty when the wired store cannot `list`.
   */
  async sessions(): Promise<BrowserSessionView[]> {
    const prefix = namedBrowserSessionKey("");
    const entries = await this.#sessionStore.list?.(prefix);
    if (!entries) return [];
    return [...entries]
      .map(([key, entry]) => ({
        name: key.slice(prefix.length),
        status:
          entry.closedAt === undefined
            ? ("live" as const)
            : ("closed" as const),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        sessionId: entry.sessionId
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Mint Live View URLs for the named session's open tabs, fresh from a
   * target listing. `undefined` when the name is unknown, closed, or its
   * browser is gone. The URLs are bearer credentials with a short connect
   * window (~5 min) — hand them to a trusted human, never to the model, and
   * never store them: re-mint instead.
   */
  async liveView(
    name = DEFAULT_BROWSER_SESSION_NAME,
    options?: { mode?: LiveViewMode }
  ): Promise<BrowserLiveView | undefined> {
    const entry = await this.#sessionStore.get(namedBrowserSessionKey(name));
    if (!entry || entry.closedAt !== undefined) return undefined;
    try {
      const targets = await listBrowserTargets(
        this.#options.browser,
        entry.sessionId
      );
      // A human is about to look: minting counts as session activity, so
      // the sweep cannot reap the browser inside the link's connection
      // window. Target listing yields to the network, so a due sweep can
      // retire the session mid-mint — the touch and the sweep serialize on
      // the per-key lock, and a lost touch means the listed targets are
      // already dead: report the session gone rather than minting doomed
      // links. Touch *errors* stay best effort — a store blip must not
      // break minting.
      try {
        const refreshed = await this.#core_().touch(name, entry.sessionId);
        if (!refreshed) return undefined;
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to refresh activity for browser session "${name}"`,
          error
        );
      }
      return mintLiveView(entry.sessionId, targets, options?.mode);
    } catch (error) {
      if (isMissingBrowserSession(error)) return undefined;
      throw error;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Lazy: `lifecycle.storage` exists only once `Lifecycle.use()` ran. */
  get #sessionStore(): BrowserSessionStore {
    this.#store ??=
      this.#options.store ??
      new DurableBrowserSessionStore(this.lifecycle.storage);
    return this.#store;
  }

  #core_(): NamedBrowserSessions {
    this.#core ??= new NamedBrowserSessions({
      browser: this.#options.browser,
      store: this.#sessionStore,
      create: this.#options.create,
      timeoutMs: this.#options.timeoutMs,
      sweepIdleMs: this.#sweepIdleMs
    });
    return this.#core;
  }

  /**
   * Schedule the sweep after a session op. The push is deliberately
   * unconditional: a job row stays visible while its own dispatch runs, and
   * a dispatch that listed an empty store retires the job by returning
   * nothing — a session op overlapping that window must supersede the
   * running row, not treat it as sufficient. A same-id push clears the
   * dispatch marker, so the stale outcome defers to this newer schedule
   * instead of deleting it.
   */
  async #scheduleSweep(): Promise<void> {
    if (this.#sessionStore.list === undefined) return;
    await this.#armSweep();
  }

  async #armSweep(): Promise<void> {
    await this.lifecycle.jobs.push({
      id: BROWSER_SWEEP_JOB_ID,
      fn: BROWSER_SWEEP_JOB_ID,
      // One job watches every name: keep the earliest pending deadline, or
      // a busy name would postpone sweeping idle names and tombstones
      // indefinitely. During a retiring dispatch the kept time may already
      // be due — the alarm then fires promptly and the fresh sweep re-times
      // itself.
      time: Math.min(
        this.lifecycle.jobs.get(BROWSER_SWEEP_JOB_ID)?.time ??
          Number.POSITIVE_INFINITY,
        Date.now() + this.#sweepIdleMs
      ),
      singleflight: true
    });
  }
}
