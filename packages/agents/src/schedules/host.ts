import type { RetryOptions } from "../retries";
import type {
  AgentPathStep,
  Schedule,
  ScheduleCriteria,
  ScheduleStorageRow
} from "./types";

type ScheduleEventType =
  | "schedule:create"
  | "schedule:cancel"
  | "schedule:execute"
  | "schedule:retry"
  | "schedule:error"
  | "schedule:duplicate_warning";

/** @internal Schedule-related root Agent RPC surface used by facets. */
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

/** @internal Narrow Agent adapter consumed by AgentScheduler. */
export interface AgentSchedulerHost {
  agent: object;
  storage: DurableObjectStorage;
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  rawSql: SqlStorage["exec"];
  emit(type: ScheduleEventType, payload: Record<string, unknown>): void;
  retryDefaults(): Required<RetryOptions>;
  hungScheduleTimeoutSeconds(): number;
  validateScheduleCallback(
    when: Date | string | number,
    callback: string,
    options?: { retry?: RetryOptions; idempotent?: boolean }
  ): void;
  isFacet(): boolean;
  selfPath(): ReadonlyArray<AgentPathStep>;
  rootAlarmOwner(): Promise<SchedulerRootRpc>;
  isSameAgentPathPrefix(
    prefix: ReadonlyArray<AgentPathStep>,
    path: ReadonlyArray<AgentPathStep>
  ): boolean;
  dispatchFacetCallback(
    ownerPath: ReadonlyArray<AgentPathStep>,
    row: ScheduleStorageRow
  ): Promise<boolean>;
  scheduleNextAlarm(): Promise<void>;
  isDestroyed(): boolean;
  onError(error: unknown): void | Promise<void>;
}

const hosts = new WeakMap<object, AgentSchedulerHost>();

/** @internal */
export function registerAgentSchedulerHost(
  owner: object,
  host: AgentSchedulerHost
): void {
  hosts.set(owner, host);
}

/** @internal */
export function getAgentSchedulerHost(
  owner: object
): AgentSchedulerHost | undefined {
  return hosts.get(owner);
}
