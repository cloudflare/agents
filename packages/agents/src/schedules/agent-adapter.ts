import type { RetryOptions } from "../retries";
import type { AgentPathStep } from "../sub-routing";
import type { SchedulerRootRpc } from "./agent-rpc";
import type { SchedulerOwner } from "./options";
import {
  getSchedulerInternals,
  type Scheduler,
  type SchedulerInternals
} from "./scheduler";
import type { Schedule, ScheduleCriteria, ScheduleStorageRow } from "./types";

/** Encode an Agent facet path as an opaque Scheduler owner. */
export function agentSchedulerOwner(
  path: ReadonlyArray<AgentPathStep>
): SchedulerOwner {
  return {
    key: scheduleOwnerPathKey(path) ?? "",
    data: JSON.stringify(path)
  };
}

/** Compute the stable owner key used by Agent alarm bookkeeping. */
export function scheduleOwnerPathKey(
  path: ReadonlyArray<AgentPathStep> | null
): string | null {
  if (!path) return null;
  return path
    .map(
      (step) =>
        `${encodeURIComponent(step.className)}:${encodeURIComponent(step.name)}`
    )
    .join("/");
}

type SchedulerAgentAdapterOptions = {
  readonly scheduler: Scheduler;
  readonly validateSchedule: (
    when: Date | string | number,
    callback: string,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ) => void;
  readonly isFacet: () => boolean;
  readonly selfPath: () => ReadonlyArray<AgentPathStep>;
  readonly rootAlarmOwner: () => Promise<SchedulerRootRpc>;
  readonly emit: (
    type: "schedule:create" | "schedule:cancel",
    payload: Record<string, unknown>
  ) => void;
  readonly isSamePathPrefix: (
    prefix: ReadonlyArray<AgentPathStep>,
    path: ReadonlyArray<AgentPathStep>
  ) => boolean;
};

/** @internal Agent-specific ownership and facet routing over Scheduler. */
export class SchedulerAgentAdapter {
  readonly #options: SchedulerAgentAdapterOptions;
  readonly #scheduler: SchedulerInternals;

  constructor(options: SchedulerAgentAdapterOptions) {
    this.#options = options;
    this.#scheduler = getSchedulerInternals(options.scheduler);
  }

  async schedule<T = string>(
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<Schedule<T>> {
    if (!this.#options.isFacet()) {
      return this.#options.scheduler.schedule(when, callback, payload, options);
    }

    this.#options.validateSchedule(when, callback, options);
    const result = await (
      await this.#options.rootAlarmOwner()
    )._cf_scheduleForFacet(
      this.#options.selfPath(),
      when,
      callback,
      payload,
      options
    );
    if (result.created) {
      this.#options.emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
  }

  async scheduleEvery<T = string>(
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<Schedule<T>> {
    if (!this.#options.isFacet()) {
      return this.#options.scheduler.scheduleEvery(
        intervalSeconds,
        callback,
        payload,
        {
          retry: options?.retry,
          idempotent: options?._idempotent
        }
      );
    }

    this.#scheduler.validateIntervalSchedule(
      intervalSeconds,
      callback,
      options?.retry
    );
    const result = await (
      await this.#options.rootAlarmOwner()
    )._cf_scheduleEveryForFacet(
      this.#options.selfPath(),
      intervalSeconds,
      callback,
      payload,
      options
    );
    if (result.created) {
      this.#options.emit("schedule:create", {
        callback: result.schedule.callback,
        id: result.schedule.id
      });
    }
    return result.schedule;
  }

  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    if (this.#options.isFacet()) {
      throw new Error(
        "getSchedule() is synchronous and cannot read parent-owned sub-agent schedules. " +
          "Use await this.getScheduleById(id) instead."
      );
    }
    return this.#options.scheduler.getSchedule<T>(id);
  }

  async getScheduleById(id: string): Promise<Schedule<unknown> | undefined> {
    if (!this.#options.isFacet()) {
      return this.#options.scheduler.getScheduleById(id);
    }
    return (await this.#options.rootAlarmOwner())._cf_getScheduleForFacet(
      this.#options.selfPath(),
      id
    );
  }

  getSchedules<T = string>(criteria: ScheduleCriteria = {}): Schedule<T>[] {
    if (this.#options.isFacet()) {
      throw new Error(
        "getSchedules() is synchronous and cannot read parent-owned sub-agent schedules. " +
          "Use await this.listSchedules(criteria) instead."
      );
    }
    return this.#options.scheduler.getSchedules<T>(criteria);
  }

  async listSchedules(
    criteria: ScheduleCriteria = {}
  ): Promise<Schedule<unknown>[]> {
    if (!this.#options.isFacet()) {
      return this.#options.scheduler.listSchedules(criteria);
    }
    return (await this.#options.rootAlarmOwner())._cf_listSchedulesForFacet(
      this.#options.selfPath(),
      criteria
    );
  }

  async cancelSchedule(id: string): Promise<boolean> {
    if (!this.#options.isFacet()) {
      return this.#options.scheduler.cancelSchedule(id);
    }
    const result = await (
      await this.#options.rootAlarmOwner()
    )._cf_cancelScheduleForFacet(this.#options.selfPath(), id);
    if (result.ok && result.callback) {
      this.#options.emit("schedule:cancel", {
        callback: result.callback,
        id
      });
    }
    return result.ok;
  }

  ensureSchema(): void {
    this.#scheduler.ensureSchema();
  }

  dropStorage(): void {
    this.#scheduler.dropStorage();
  }

  insertForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this.#scheduler.insertForOwner(
      agentSchedulerOwner(ownerPath),
      when,
      callback,
      payload,
      options
    );
  }

  insertIntervalForOwner<T = string>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this.#scheduler.insertIntervalForOwner(
      agentSchedulerOwner(ownerPath),
      intervalSeconds,
      callback,
      payload,
      {
        retry: options?.retry,
        idempotent: options?._idempotent
      }
    );
  }

  cancelForOwner(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<{ ok: boolean; callback?: string }> {
    return this.#scheduler.cancelForOwner(agentSchedulerOwner(ownerPath), id);
  }

  getForOwner(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Schedule<unknown> | undefined {
    return this.#scheduler.getForOwner(agentSchedulerOwner(ownerPath), id);
  }

  listForOwner(
    ownerPath: ReadonlyArray<AgentPathStep>,
    criteria: ScheduleCriteria
  ): Schedule<unknown>[] {
    return this.#scheduler.listForOwner(
      agentSchedulerOwner(ownerPath),
      criteria
    );
  }

  executeCallback(row: ScheduleStorageRow): Promise<void> {
    return this.#scheduler.executeCallback(row);
  }

  takeExecutingScheduleRowId(): string | undefined {
    return this.#scheduler.takeExecutingScheduleRowId();
  }

  purgeMemoryLimitedRows(
    callbacks: ReadonlyArray<string>,
    executingRowId?: string
  ): void {
    this.#scheduler.deleteRows(callbacks, executingRowId);
  }

  backoffMemoryLimitedRows(
    callbacks: ReadonlyArray<string>,
    executingRowId: string | undefined,
    nextTime: number
  ): void {
    this.#scheduler.moveRows(callbacks, executingRowId, nextTime);
  }

  cancelOwnerPrefix(ownerPath: ReadonlyArray<AgentPathStep>): void {
    this.#scheduler.cancelOwners((ownerData) => {
      try {
        const rowPath = JSON.parse(ownerData) as AgentPathStep[];
        return this.#options.isSamePathPrefix(ownerPath, rowPath);
      } catch {
        return false;
      }
    });
  }
}
