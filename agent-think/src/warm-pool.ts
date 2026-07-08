import { DurableObject } from "cloudflare:workers";

const WARM_TARGET = 1;
const REFRESH_INTERVAL_MS = 10_000;

interface ContainerRpc {
  startAndWaitForPorts(): Promise<void>;
  stop(signal?: string): Promise<void>;
  getState(): Promise<{ status: "healthy" | "stopped" }>;
}

export interface PoolStats {
  warm: number;
  assigned: number;
  total: number;
  target: number;
}

interface WarmPoolEnv {
  Sandbox: DurableObjectNamespace;
}

/**
 * Maintains one ready container and lends containers to agent turns.
 *
 * A claim consumes a warm container and starts its replacement immediately.
 * Releasing a claim stops the used container; containers are never returned
 * with another turn's home-directory or process state attached.
 */
export class WarmPool extends DurableObject<WarmPoolEnv> {
  #warm = new Set<string>();
  #assignments = new Map<string, string>();
  #fillPromise: Promise<void> | null = null;
  #initialized = false;

  async claimContainer(sessionId: string): Promise<string> {
    await this.#init();

    const existing = this.#assignments.get(sessionId);
    if (existing && (await this.#isAlive(existing))) {
      this.#refillInBackground();
      return existing;
    }
    if (existing) {
      this.#assignments.delete(sessionId);
      await this.#persist();
    }

    let uuid: string | undefined;
    while (this.#warm.size > 0 && !uuid) {
      const candidate = this.#warm.values().next().value as string;
      this.#warm.delete(candidate);
      if (await this.#isAlive(candidate)) uuid = candidate;
    }
    if (!uuid) uuid = await this.#startContainer();

    this.#assignments.set(sessionId, uuid);
    await this.#persist();
    this.#refillInBackground();
    return uuid;
  }

  async releaseAssignment(sessionId: string): Promise<boolean> {
    await this.#init();
    const uuid = this.#assignments.get(sessionId);
    if (!uuid) return false;

    this.#assignments.delete(sessionId);
    await this.#persist();
    await this.#stopContainer(uuid);
    await this.ensureWarm();
    return true;
  }

  async ensureWarm(): Promise<void> {
    await this.#init();
    if (this.#fillPromise) return this.#fillPromise;

    const fill = this.#refreshWarm().finally(() => {
      if (this.#fillPromise === fill) this.#fillPromise = null;
    });
    this.#fillPromise = fill;
    return fill;
  }

  async getStats(): Promise<PoolStats> {
    await this.#init();
    return {
      warm: this.#warm.size,
      assigned: this.#assignments.size,
      total: this.#warm.size + this.#assignments.size,
      target: WARM_TARGET
    };
  }

  async alarm(): Promise<void> {
    await this.#init();
    try {
      await this.#removeStoppedAssignments();
      await this.ensureWarm();
    } catch (error) {
      console.error({
        message: "WarmPool maintenance failed",
        component: "warm-pool",
        error
      });
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + REFRESH_INTERVAL_MS);
    }
  }

  async #init(): Promise<void> {
    if (this.#initialized) return;

    const retired: string[] = [];
    const storedWarm =
      await this.ctx.storage.get<Set<string>>("warmContainers");
    if (storedWarm) {
      const [keep, ...extras] = [...storedWarm];
      if (keep) this.#warm.add(keep);
      retired.push(...extras);
    }

    const schemaVersion =
      (await this.ctx.storage.get<number>("poolSchemaVersion")) ?? 1;
    const storedAssignments =
      await this.ctx.storage.get<Map<string, string | { uuid: string }>>(
        "assignments"
      );
    if (storedAssignments) {
      for (const [sessionId, value] of storedAssignments) {
        const uuid = typeof value === "string" ? value : value.uuid;
        if (schemaVersion === 2 && typeof value === "string") {
          this.#assignments.set(sessionId, uuid);
        } else {
          // Retire every sticky/lease assignment on the one-time schema
          // migration. A recovering turn will claim a fresh warm container.
          retired.push(uuid);
        }
      }
    }

    this.#initialized = true;
    await Promise.all(retired.map((uuid) => this.#stopContainer(uuid)));
    await this.#persist();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REFRESH_INTERVAL_MS);
    }
  }

  async #refreshWarm(): Promise<void> {
    let changed = false;
    for (const uuid of [...this.#warm]) {
      if (!(await this.#isAlive(uuid))) {
        this.#warm.delete(uuid);
        changed = true;
      }
    }
    if (changed) await this.#persist();

    while (this.#warm.size < WARM_TARGET) {
      try {
        this.#warm.add(await this.#startContainer());
        await this.#persist();
      } catch (error) {
        console.error({
          message: "Failed to replenish warm container",
          component: "warm-pool",
          error
        });
        return;
      }
    }
  }

  #refillInBackground(): void {
    this.ctx.waitUntil(
      this.ensureWarm().catch((error) =>
        console.error({
          message: "Background warm-container refill failed",
          component: "warm-pool",
          error
        })
      )
    );
  }

  async #removeStoppedAssignments(): Promise<void> {
    let changed = false;
    for (const [sessionId, uuid] of [...this.#assignments]) {
      if (!(await this.#isAlive(uuid))) {
        this.#assignments.delete(sessionId);
        changed = true;
      }
    }
    if (changed) await this.#persist();
  }

  async #startContainer(): Promise<string> {
    const uuid = crypto.randomUUID();
    const sandbox = this.#sandbox(uuid);
    await sandbox.startAndWaitForPorts();
    console.info({
      message: "Container started",
      component: "warm-pool",
      containerUUID: uuid
    });
    return uuid;
  }

  async #stopContainer(uuid: string): Promise<void> {
    try {
      await this.#sandbox(uuid).stop();
    } catch (error) {
      console.warn({
        message: "Failed to stop released container",
        component: "warm-pool",
        containerUUID: uuid,
        error
      });
    }
  }

  async #isAlive(uuid: string): Promise<boolean> {
    try {
      return (await this.#sandbox(uuid).getState()).status === "healthy";
    } catch {
      return false;
    }
  }

  async #persist(): Promise<void> {
    await this.ctx.storage.put({
      poolSchemaVersion: 2,
      warmContainers: this.#warm,
      assignments: this.#assignments
    });
  }

  #sandbox(uuid: string): ContainerRpc {
    const id = this.env.Sandbox.idFromName(uuid);
    return this.env.Sandbox.get(id) as unknown as ContainerRpc;
  }
}
