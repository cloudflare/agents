import type { RetryOptions } from "../retries";
import type { AgentPathStep } from "../sub-routing";
import type { Schedule, ScheduleCriteria } from "./types";

/** @internal Schedule RPC surface exposed by a root Agent to its facets. */
export interface SchedulerRootRpc {
  _cf_scheduleForFacet<T>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }>;
  _cf_scheduleEveryForFacet<T>(
    ownerPath: ReadonlyArray<AgentPathStep>,
    intervalSeconds: number,
    callback: string,
    payload?: T,
    options?: { retry?: RetryOptions; _idempotent?: boolean }
  ): Promise<{ schedule: Schedule<T>; created: boolean }>;
  _cf_cancelScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<{ ok: boolean; callback?: string }>;
  _cf_getScheduleForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<Schedule<unknown> | undefined>;
  _cf_listSchedulesForFacet(
    ownerPath: ReadonlyArray<AgentPathStep>,
    criteria?: ScheduleCriteria
  ): Promise<Schedule<unknown>[]>;
}
