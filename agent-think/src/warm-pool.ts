/**
 * WarmPool — Durable Object that maintains a pool of pre-started sandbox containers.
 *
 * Adapted from https://github.com/mikenomitch/cf-container-warm-pool
 * Inlined and tailored for the @cloudflare/sandbox SDK.
 *
 * The pool keeps N idle containers standing by so new sandbox sessions boot
 * instantly.  Once a container is assigned to a sandbox ID it is consumed and
 * never returned to the pool.
 *
 * Configuration is pushed in via `configure()` on every request (idempotent)
 * so changes to wrangler vars take effect without manual intervention.
 */

import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WarmPoolConfig {
  /** Target number of warm (unassigned) containers to maintain. @default 0 */
  warmTarget?: number;
  /** How often to check and replenish warm containers (ms). @default 10000 */
  refreshInterval?: number;
  /**
   * How long an assignment can sit untouched before the pool reclaims it,
   * in ms. `getContainer` bumps the touched-at timestamp on every call, so
   * an active session keeps its container indefinitely; once the agent
   * stops issuing exec calls (DO hibernated, room idle, browser tab
   * closed) the slot eventually frees up rather than burning a quota seat
   * forever. @default 3_600_000 (1 hour). Set to 0 to disable.
   */
  assignmentIdleTtl?: number;
}

export interface PoolStats {
  /** Number of warm (unassigned) containers ready for use */
  warm: number;
  /** Number of containers assigned to sandbox IDs */
  assigned: number;
  /** Total containers tracked by the pool */
  total: number;
  /** Current pool configuration */
  config: Required<WarmPoolConfig>;
  /** Inferred max_instances limit, or null if not yet known */
  maxInstances: number | null;
}

// ---------------------------------------------------------------------------
// Container RPC shapes (inherited by Sandbox from Container)
// ---------------------------------------------------------------------------

interface ContainerRpc {
  startAndWaitForPorts(): Promise<void>;
  stop(signal?: string): Promise<void>;
  renewActivityTimeout(): void;
}

interface ContainerState {
  lastChange: number;
  status: "running" | "stopping" | "stopped" | "healthy" | "stopped_with_code";
  exitCode?: number;
}

interface ContainerWithState {
  getState(): Promise<ContainerState>;
}

/** Persisted assignment row: the container UUID plus a last-touched stamp. */
export interface AssignmentRecord {
  uuid: string;
  /** Wall-clock ms of the last `getContainer` call — drives idle eviction. */
  touchedAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<WarmPoolConfig> = {
  warmTarget: 0,
  refreshInterval: 10_000,
  assignmentIdleTtl: 3_600_000
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests so we don't have to spin up a DO)
// ---------------------------------------------------------------------------

/**
 * Decide which assignments are old enough to evict. Pure function so
 * the alarm-side logic is unit-testable without the DO runtime.
 *
 *   - `ttl <= 0` disables eviction — returns `[]`.
 *   - An entry is expired iff `now - touchedAt >= ttl`.
 *   - Returns the *snapshots* (uuid + touchedAt) rather than mutating
 *     the map; the caller deletes and stops containers in DO context.
 */
export function selectExpiredAssignments(
  assignments: Iterable<[string, AssignmentRecord]>,
  now: number,
  ttl: number
): Array<{ sandboxId: string; uuid: string; touchedAt: number }> {
  if (ttl <= 0) return [];
  const cutoff = now - ttl;
  const expired: Array<{ sandboxId: string; uuid: string; touchedAt: number }> =
    [];
  for (const [sandboxId, record] of assignments) {
    if (record.touchedAt <= cutoff) {
      expired.push({
        sandboxId,
        uuid: record.uuid,
        touchedAt: record.touchedAt
      });
    }
  }
  return expired;
}

/**
 * Mirror of the SDK’s `Container.containerFetch` short-circuit. The pool
 * uses this to decide whether handing an existing UUID back to a caller
 * will avoid a re-start path; tests use it to pin the predicate without
 * touching the DO base class.
 */
export function isAssignmentStateUsable(status: string): boolean {
  return status === "healthy";
}

// ---------------------------------------------------------------------------
// WarmPool Durable Object
// ---------------------------------------------------------------------------

/**
 * The WarmPool expects an environment with a `Sandbox` Durable Object binding.
 * This interface describes the minimum shape; the actual binding name is
 * configurable via the bridge, but defaults to "Sandbox".
 */
interface WarmPoolEnv {
  // The Sandbox DO is defined in apps/agent/src/sandbox.ts and
  // implements `startAndWaitForPorts`, `stop`, `getState`, and
  // `renewActivityTimeout` as RPC methods — the same surface the
  // old `@cloudflare/sandbox` SDK exposed via its Container base
  // class. Typed loosely here because the pool only depends on
  // those four methods.
  Sandbox: DurableObjectNamespace;
  [key: string]: unknown;
}

export class WarmPool extends DurableObject<WarmPoolEnv> {
  private config: Required<WarmPoolConfig> = { ...DEFAULT_CONFIG };

  /** Container UUIDs that are warm and available for assignment */
  private warmContainers: Set<string> = new Set();

  /**
   * Maps caller-provided sandbox IDs to container assignments.
   *
   * `touchedAt` is updated on every `getContainer` call. The idle-eviction
   * pass in `alarm()` drops any assignment whose `touchedAt` is older than
   * `assignmentIdleTtl`. Previously this was `Map<string, string>` and
   * assignments lived forever, which leaked quota slots across hibernated
   * agents — see the `getContainer` and `alarm` paths.
   */
  private assignments: Map<string, AssignmentRecord> = new Map();

  /** Containers currently starting — excluded from health checks */
  private startingContainers: Set<string> = new Set();

  /** Inferred max_instances limit learned from Cloudflare errors, or null */
  private knownMaxInstances: number | null = null;

  private capacityExhausted = false;
  private initialized = false;

  /**
   * Clock source. Overridable via `setClockForTesting` so unit tests can
   * drive idle-eviction without burning wall time. Defaults to `Date.now`
   * which the workerd runtime advances correctly inside DO context.
   */
  private clock: () => number = Date.now;

  /** Test seam: override the clock used for touchedAt and alarm scheduling. */
  setClockForTesting(clock: () => number): void {
    this.clock = clock;
  }

  private now(): number {
    return this.clock();
  }

  // =======================================================================
  // Public RPC methods
  // =======================================================================

  /**
   * Get a container UUID for the given sandbox ID.
   * - If this ID already has an assigned container that's still running, return it.
   * - Otherwise assign a warm container (or start a new one).
   */
  async getContainer(sandboxId: string): Promise<string> {
    await this.init();
    const now = this.now();

    const existing = this.assignments.get(sandboxId);
    if (existing) {
      const usable = await this.isAssignmentUsable(existing.uuid);
      if (usable) {
        // Touch the assignment so a long-running session doesn't get its
        // container reclaimed mid-conversation by the idle-eviction pass.
        existing.touchedAt = now;
        await this.persist();
        return existing.uuid;
      }
      this.assignments.delete(sandboxId);
      await this.persist();
    }

    // Try to pop a warm container
    if (this.warmContainers.size > 0) {
      const containerUUID = this.warmContainers.values().next().value as string;
      this.warmContainers.delete(containerUUID);
      this.assignments.set(sandboxId, { uuid: containerUUID, touchedAt: now });
      await this.persist();
      return containerUUID;
    }

    // Check capacity before starting on-demand
    if (this.remainingCapacity() <= 0) {
      this.throwCapacityError();
    }

    // Start one on-demand
    const containerUUID = await this.startContainer();
    if (containerUUID) {
      this.assignments.set(sandboxId, { uuid: containerUUID, touchedAt: now });
      await this.persist();
      return containerUUID;
    }

    if (this.capacityExhausted) {
      this.throwCapacityError();
    }

    throw new Error("Failed to start container");
  }

  /**
   * Look up an existing container assignment without allocating.
   * Returns the container UUID if the sandbox ID has an active assignment, null otherwise.
   * Used by DELETE to avoid starting a container just to destroy it.
   */
  async lookupContainer(sandboxId: string): Promise<string | null> {
    await this.init();
    const existing = this.assignments.get(sandboxId);
    return existing ? existing.uuid : null;
  }

  /**
   * Report that a container has stopped — removes it from tracking.
   */
  async reportStopped(containerUUID: string): Promise<void> {
    await this.init();
    this.removeContainer(containerUUID);
    await this.persist();
  }

  /**
   * Explicitly release a sandbox→container assignment. Stops the container
   * (best effort) and drops the assignment so the quota slot is freed
   * immediately rather than waiting for the idle-eviction sweep.
   *
   * Idempotent: calling for an unknown sandbox ID is a no-op. Used by the
   * Agent when a thread is reset or explicitly torn down.
   */
  async releaseAssignment(sandboxId: string): Promise<boolean> {
    await this.init();
    const existing = this.assignments.get(sandboxId);
    if (!existing) return false;
    this.assignments.delete(sandboxId);
    await this.persist();
    await this.stopContainerSafely(existing.uuid);
    return true;
  }

  /**
   * Get current pool statistics.
   */
  async getStats(): Promise<PoolStats> {
    await this.init();
    return {
      warm: this.warmContainers.size,
      assigned: this.assignments.size,
      total: this.warmContainers.size + this.assignments.size,
      config: this.config,
      maxInstances: this.knownMaxInstances
    };
  }

  /**
   * Update pool configuration. Idempotent — called on every request to keep
   * config in sync with wrangler vars across deploys.
   */
  async configure(config: WarmPoolConfig): Promise<void> {
    await this.init();
    this.config = { ...DEFAULT_CONFIG, ...config };
    await this.ctx.storage.put("config", this.config);
  }

  /**
   * Shutdown all pre-warmed (unassigned) containers.
   * Does not affect containers that are assigned to sandbox IDs.
   */
  async shutdownPrewarmed(): Promise<void> {
    await this.init();

    for (const containerUUID of [...this.warmContainers]) {
      try {
        const stub = this.getSandboxStub(containerUUID);
        await (stub as unknown as ContainerRpc).stop();
        this.warmContainers.delete(containerUUID);
      } catch (error) {
        console.error({
          message: "Failed to stop container",
          component: "warm-pool",
          containerUUID,
          error
        });
      }
    }

    await this.persist();
  }

  // =======================================================================
  // Alarm handler
  // =======================================================================

  async alarm(): Promise<void> {
    await this.init();

    this.capacityExhausted = false;

    try {
      // Order matters: evict idle assignments first so checkContainerHealth
      // doesn’t do a pointless getState() on a container we’re about to
      // stop, and so adjustPool sees the freed capacity when deciding how
      // many to start.
      await this.evictIdleAssignments();
      await this.checkContainerHealth();
      await this.adjustPool();
      await this.keepWarmContainersAlive();
    } catch (error) {
      console.error({
        message: "Alarm handler error",
        component: "warm-pool",
        error
      });
    }

    await this.ctx.storage.setAlarm(this.now() + this.config.refreshInterval);
  }

  // =======================================================================
  // Private — initialisation & persistence
  // =======================================================================

  private async init(): Promise<void> {
    if (this.initialized) return;

    const storedWarm =
      await this.ctx.storage.get<Set<string>>("warmContainers");
    if (storedWarm) this.warmContainers = new Set(storedWarm);

    // Assignments shape changed from `Map<string,string>` to
    // `Map<string, { uuid, touchedAt }>`. Migrate the old shape on read
    // so a rolling deploy doesn’t lose existing assignments — they just
    // start with a fresh touchedAt of “now”, giving each one a full idle
    // window from the moment the new code first reads it.
    const storedAssignments =
      await this.ctx.storage.get<Map<string, string | AssignmentRecord>>(
        "assignments"
      );
    if (storedAssignments) {
      const now = this.now();
      this.assignments = new Map();
      for (const [sandboxId, value] of storedAssignments) {
        if (typeof value === "string") {
          this.assignments.set(sandboxId, { uuid: value, touchedAt: now });
        } else {
          this.assignments.set(sandboxId, value);
        }
      }
    }

    const storedConfig = await this.ctx.storage.get<WarmPoolConfig>("config");
    if (storedConfig) this.config = { ...DEFAULT_CONFIG, ...storedConfig };

    const storedMax = await this.ctx.storage.get<number>("knownMaxInstances");
    if (storedMax !== undefined) this.knownMaxInstances = storedMax;

    this.initialized = true;
    await this.scheduleRefresh();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("warmContainers", this.warmContainers);
    await this.ctx.storage.put("assignments", this.assignments);
    if (this.knownMaxInstances !== null) {
      await this.ctx.storage.put("knownMaxInstances", this.knownMaxInstances);
    } else {
      await this.ctx.storage.delete("knownMaxInstances");
    }
  }

  private async scheduleRefresh(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) {
      await this.ctx.storage.setAlarm(this.now() + this.config.refreshInterval);
    }
  }

  // =======================================================================
  // Private — container lifecycle
  // =======================================================================

  private async startContainer(): Promise<string | null> {
    const containerUUID = crypto.randomUUID();
    this.startingContainers.add(containerUUID);

    try {
      const stub = this.getSandboxStub(containerUUID);
      await (stub as unknown as ContainerRpc).startAndWaitForPorts();
      console.info({
        message: "Container started",
        component: "warm-pool",
        containerUUID
      });
      return containerUUID;
    } catch (error) {
      if (this.isMaxInstancesError(error)) {
        await this.recordCapacityLimit();
      } else {
        console.error({
          message: "Failed to start container",
          component: "warm-pool",
          containerUUID,
          error
        });
      }
      return null;
    } finally {
      this.startingContainers.delete(containerUUID);
    }
  }

  /**
   * Strict liveness check used by `getContainer` before handing an
   * existing assignment back to a caller.
   *
   * Requires `healthy` because that's what `Container.containerFetch`
   * also checks before it skips `startAndWaitForPorts(port)`. A container
   * in plain `running` state (workerd booting, defaultPort bound but
   * other ports not yet) will trigger a re-start path on the very next
   * fetch, which is what surfaces as a 503 when capacity is tight —
   * exactly the failure mode in 2pv6qaa4tn7ez5c26ab6cdkbkr. If the
   * assignment isn't `healthy` yet we drop it and grab a fresh
   * container, leaving the not-yet-healthy one to either complete its
   * boot (in which case the next sweep will reclaim it) or die.
   */
  private async isAssignmentUsable(containerUUID: string): Promise<boolean> {
    if (this.startingContainers.has(containerUUID)) return true;
    try {
      const stub = this.getSandboxStub(containerUUID);
      const state = await (stub as unknown as ContainerWithState).getState();
      return isAssignmentStateUsable(state.status);
    } catch (error) {
      console.warn({
        message: "Failed to check container status, assuming stopped",
        component: "warm-pool",
        containerUUID,
        error
      });
      return false;
    }
  }

  /**
   * Looser liveness check used by the periodic health sweep. Keeps
   * containers that are merely `running` (mid-boot, transient port
   * flake) so we don’t evict them faster than they can become healthy.
   * Only removes containers the platform has clearly given up on.
   */
  private async isContainerAlive(containerUUID: string): Promise<boolean> {
    if (this.startingContainers.has(containerUUID)) return true;
    try {
      const stub = this.getSandboxStub(containerUUID);
      const state = await (stub as unknown as ContainerWithState).getState();
      return state.status === "running" || state.status === "healthy";
    } catch (error) {
      console.warn({
        message: "Failed to check container status, assuming stopped",
        component: "warm-pool",
        containerUUID,
        error
      });
      return false;
    }
  }

  private async checkContainerHealth(): Promise<void> {
    const allUUIDs = [
      ...this.warmContainers,
      ...[...this.assignments.values()].map((a) => a.uuid)
    ];

    let anyRemoved = false;
    for (const uuid of allUUIDs) {
      const alive = await this.isContainerAlive(uuid);
      if (!alive) {
        console.info({
          message: "Container not running, removing from pool",
          component: "warm-pool",
          containerUUID: uuid
        });
        if (this.removeContainer(uuid)) anyRemoved = true;
      }
    }

    if (anyRemoved) await this.persist();
  }

  /**
   * Drop assignments whose `touchedAt` is older than `assignmentIdleTtl`
   * and stop the underlying containers. The DO behind the assignment
   * keeps its own state in storage, so a session that comes back later
   * just gets a fresh container — the workspace VFS, message log, and
   * agent state survive on their own DOs.
   *
   * No-op when `assignmentIdleTtl` is 0 (eviction disabled).
   */
  private async evictIdleAssignments(): Promise<void> {
    const expired = selectExpiredAssignments(
      this.assignments,
      this.now(),
      this.config.assignmentIdleTtl
    );
    if (expired.length === 0) return;
    for (const { sandboxId, uuid, touchedAt } of expired) {
      this.assignments.delete(sandboxId);
      console.info({
        message: "Evicting idle assignment",
        component: "warm-pool",
        sandboxId,
        containerUUID: uuid,
        idleMs: this.now() - touchedAt
      });
      await this.stopContainerSafely(uuid);
    }
    await this.persist();
  }

  /**
   * Best-effort `stop()` on a container. Failures (already stopped, lost
   * stub, etc.) are logged but never thrown — the assignment is gone
   * either way and the caller can’t recover.
   */
  private async stopContainerSafely(containerUUID: string): Promise<void> {
    try {
      const stub = this.getSandboxStub(containerUUID);
      await (stub as unknown as ContainerRpc).stop();
    } catch (error) {
      console.warn({
        message: "Failed to stop released container",
        component: "warm-pool",
        containerUUID,
        error
      });
    }
  }

  /**
   * Renew activity timeout on all warm containers to prevent them from sleeping.
   */
  private async keepWarmContainersAlive(): Promise<void> {
    for (const containerUUID of this.warmContainers) {
      try {
        const stub = this.getSandboxStub(containerUUID);
        (stub as unknown as ContainerRpc).renewActivityTimeout();
      } catch (error) {
        console.error({
          message: "Failed to renew activity timeout",
          component: "warm-pool",
          containerUUID,
          error
        });
      }
    }
  }

  /**
   * Scale the warm pool towards warmTarget, respecting inferred max_instances.
   */
  private async adjustPool(): Promise<void> {
    let diff = this.config.warmTarget - this.warmContainers.size;

    if (diff > 0) {
      const capacity = this.remainingCapacity();

      // Probe with one start to detect if max_instances was increased
      if (capacity === 0 && this.knownMaxInstances !== null) {
        console.info({
          message: "Pool at inferred limit, probing for capacity changes",
          component: "warm-pool",
          knownMaxInstances: this.knownMaxInstances
        });
        const probeUUID = await this.startContainer();
        if (probeUUID) {
          console.info({
            message: "Probe succeeded, clearing cached limit",
            component: "warm-pool"
          });
          this.knownMaxInstances = null;
          this.warmContainers.add(probeUUID);
          diff--;
          await this.persist();
        } else {
          await this.persist();
          return;
        }
      }

      const toStart = Math.min(diff, this.remainingCapacity());
      if (toStart <= 0) {
        console.log({
          message: "Cannot scale up pool",
          component: "warm-pool",
          needed: diff,
          available: this.remainingCapacity(),
          warm: this.warmContainers.size,
          assigned: this.assignments.size,
          knownMaxInstances: this.knownMaxInstances ?? "unknown"
        });
        return;
      }

      console.info({
        message: "Scaling up pool",
        component: "warm-pool",
        starting: toStart,
        needed: diff,
        capacity: this.remainingCapacity()
      });
      for (let i = 0; i < toStart; i++) {
        if (this.capacityExhausted) {
          console.log({
            message: "Capacity exhausted mid-loop, stopping further starts",
            component: "warm-pool"
          });
          break;
        }
        const uuid = await this.startContainer();
        if (uuid) this.warmContainers.add(uuid);
      }
      await this.persist();
    } else if (diff < 0) {
      const excess = -diff;
      console.info({
        message: "Scaling down pool",
        component: "warm-pool",
        stopping: excess
      });

      const toStop = [...this.warmContainers].slice(0, excess);
      const stopped: string[] = [];

      for (const uuid of toStop) {
        try {
          const stub = this.getSandboxStub(uuid);
          await (stub as unknown as ContainerRpc).stop();
          stopped.push(uuid);
        } catch (error) {
          console.error({
            message: "Failed to stop container",
            component: "warm-pool",
            containerUUID: uuid,
            error
          });
        }
      }

      for (const uuid of stopped) {
        this.warmContainers.delete(uuid);
      }
      await this.persist();
    }
  }

  // =======================================================================
  // Private — helpers
  // =======================================================================

  private removeContainer(containerUUID: string): boolean {
    let removed = false;

    if (this.warmContainers.delete(containerUUID)) removed = true;

    for (const [sandboxId, record] of this.assignments) {
      if (record.uuid === containerUUID) {
        this.assignments.delete(sandboxId);
        removed = true;
        break;
      }
    }

    return removed;
  }

  private remainingCapacity(): number {
    if (this.knownMaxInstances === null) return Infinity;
    return Math.max(
      0,
      this.knownMaxInstances -
        (this.warmContainers.size + this.assignments.size)
    );
  }

  private isMaxInstancesError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(
      "Maximum number of running container instances exceeded"
    );
  }

  private async recordCapacityLimit(): Promise<void> {
    const currentTotal = this.warmContainers.size + this.assignments.size;
    this.knownMaxInstances = currentTotal;
    this.capacityExhausted = true;
    console.warn({
      message: "Hit max_instances limit",
      component: "warm-pool",
      inferredCeiling: currentTotal,
      warm: this.warmContainers.size,
      assigned: this.assignments.size
    });
    await this.ctx.storage.put("knownMaxInstances", this.knownMaxInstances);
  }

  private throwCapacityError(): never {
    const total = this.warmContainers.size + this.assignments.size;
    throw new Error(
      `Cannot start container: instance limit reached (${total}/${this.knownMaxInstances}). ` +
        "All container slots are in use. Wait for existing containers to stop."
    );
  }

  private getSandboxStub(containerUUID: string): DurableObjectStub {
    const id = this.env.Sandbox.idFromName(containerUUID);
    return this.env.Sandbox.get(id);
  }
}
