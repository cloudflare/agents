import { NotFoundError, ValidationError } from "../kernel/errors.js";
import { createEventBus, type EventBus } from "../kernel/events.js";
import { defaultIdSource, type IdSource } from "../kernel/ids.js";
import type { AgentHandle, AgentSpawner } from "../ports/agent-spawner.js";
import type { AlarmTimer } from "../ports/alarms.js";
import type { Clock } from "../ports/clock.js";
import type { EmailMessage, EmailTransport } from "../ports/email.js";
import { scoped, type KeyValueStore } from "../ports/storage.js";
import type { WorkflowRuntime } from "../ports/workflow-runtime.js";

import {
  createSubAgentRegistry,
  type SubAgentRecord,
  type SubAgentRegistry,
} from "../domain/delegation/registry.js";
import {
  RECOVERY_SCHEDULE_ID,
  createFiberService,
  type FiberContext,
  type FiberInspection,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
  type FiberService,
  type FiberStatus,
  type StartResult,
} from "../domain/runtime/fibers/fibers.js";
import { createConversationEventLog, type ConversationEvent, type ConversationEventLog } from "../domain/events/log.js";
import { createTaskQueue, type QueueItem, type TaskQueue } from "../domain/runtime/queue/queue.js";
import {
  createCallableRegistry,
  scanCallables,
  type CallableMetadata,
  type CallableRegistry,
} from "../domain/runtime/rpc/callable.js";
import {
  createKeepAlive,
  type KeepAlive,
} from "../domain/runtime/scheduling/keep-alive.js";
import {
  createScheduler,
  type ListCriteria,
  type RetryPolicy,
  type Schedule,
  type ScheduleSpec,
  type Scheduler,
} from "../domain/runtime/scheduling/scheduler.js";
import { createStateContainer, type StateContainer, type StateSource } from "../domain/runtime/state/state.js";
import {
  createWorkflowService,
  type WorkflowInfo,
  type WorkflowService,
  type WorkflowStatus,
} from "../domain/workflows/workflows.js";
import type { AgentCoreApi } from "./capabilities.js";

/** Internal schedule/callback names are namespaced under this prefix (see scheduler.ts). */
const INTERNAL_PREFIX = "$internal:";

/** State-change origin, matching `ConversationEvent`'s "state:changed" vocabulary (audit 25 §1). */
export type StateOrigin = { kind: "server" } | { kind: "client"; sourceId: string };

/**
 * The adapter contract the app layer composes over. Provided by an adapter
 * (in-memory for tests/e2e, a future Cloudflare Durable Object adapter for
 * production). The adapter owns driving the lifecycle entry points
 * (`start()`, `onAlarm()`) and translating its own inbound surface into calls
 * on the agent's typed public methods — the agent never holds a connection or
 * parses a wire frame (audit 25).
 */
export interface AgentRuntime {
  className: string;
  name: string;
  store: KeyValueStore;
  /** The adapter must call `agent.onAlarm()` when this timer fires. */
  alarm: AlarmTimer;
  clock: Clock;
  ids?: IdSource;
  spawner?: AgentSpawner;
  email?: EmailTransport;
  workflowRuntime?: WorkflowRuntime;
  /** Root-first ancestor chain, set by the spawner that constructed this instance. */
  parentPath?: Array<{ className: string; name: string }>;
  /** Adapter-specific teardown seam, invoked at the end of `destroy()`. */
  onDestroyed?: () => void | Promise<void>;
}

/**
 * @deprecated Renamed to {@link AgentRuntime} (ISSUE-030: the name signals
 * capabilities provided to the agent, not a `this`-handle). Alias retained
 * for one milestone so in-flight branches and ported fixtures keep
 * compiling; will be removed.
 */
export type AgentHost = AgentRuntime;

/**
 * Thin composition root: wires the domain services over a scoped-per-module
 * view of `host.store`, exposes their operations as a flat delegation
 * surface, and defines the overridable hook seams (`onStart`, ...). No
 * business logic lives here — every decision belongs to a domain service or
 * a subclass hook. Transport (frames, connections) is entirely an adapter
 * concern: this class only ever publishes typed `ConversationEvent`s to its
 * own event log and exposes typed methods for adapters to call.
 */
export class Agent<State = unknown> implements AgentCoreApi {
  readonly host: AgentRuntime;
  /** Telemetry bus: fire-and-forget diagnostics, distinct from ConversationEvents. */
  readonly bus: EventBus;
  readonly ids: IdSource;

  private readonly internalCallbacks = new Map<
    string,
    (payload: unknown, schedule: Schedule) => Promise<void>
  >();

  protected readonly schedulerService: Scheduler;
  protected readonly keepAliveService: KeepAlive;
  protected readonly fiberService: FiberService;
  private readonly taskQueue: TaskQueue;
  private readonly stateContainer: StateContainer<State>;
  private readonly subAgents?: SubAgentRegistry;
  private readonly workflows?: WorkflowService;
  private readonly callableRegistry: CallableRegistry;
  private readonly eventLog: ConversationEventLog;
  private callablesScanned = false;

  constructor(host: AgentRuntime) {
    this.host = host;
    this.ids = host.ids ?? defaultIdSource;
    this.bus = createEventBus({ agent: host.className, name: host.name }, () => host.clock.now());
    this.eventLog = createConversationEventLog({ store: scoped(host.store, "evlog:"), clock: host.clock });

    this.schedulerService = createScheduler({
      store: host.store,
      alarm: host.alarm,
      clock: host.clock,
      ids: this.ids,
      bus: this.bus,
      dispatch: (callback, payload, schedule) => this.dispatchSchedule(callback, payload, schedule),
    });

    this.keepAliveService = createKeepAlive(this.schedulerService);

    this.fiberService = createFiberService({
      store: host.store,
      clock: host.clock,
      ids: this.ids,
      bus: this.bus,
      keepAlive: this.keepAliveService,
      scheduler: this.schedulerService,
      onRecovered: (ctx) => Promise.resolve(this.onFiberRecovered(ctx)),
    });
    this.internalCallbacks.set(RECOVERY_SCHEDULE_ID, async () => {
      await this.fiberService.checkInterrupted();
    });

    this.taskQueue = createTaskQueue({
      store: host.store,
      clock: host.clock,
      ids: this.ids,
      bus: this.bus,
      dispatch: (callback, payload, item) => this.dispatchQueue(callback, payload, item),
    });

    this.stateContainer = createStateContainer<State>({
      store: host.store,
      bus: this.bus,
      initialState: this.getInitialState(),
      validate: (next, source) => this.validateStateChange(next, source),
      onChanged: (state, source) => this.onStateChanged(state, source),
    });

    if (host.spawner) {
      this.subAgents = createSubAgentRegistry({
        store: host.store,
        spawner: host.spawner,
        clock: host.clock,
        ids: this.ids,
      });
    }

    if (host.workflowRuntime) {
      this.workflows = createWorkflowService({
        store: host.store,
        runtime: host.workflowRuntime,
        clock: host.clock,
        ids: this.ids,
        bus: this.bus,
        hooks: {
          onProgress: (wf, payload) => this.onWorkflowProgress(wf, payload),
          onComplete: (wf) => this.onWorkflowComplete(wf),
        },
      });
    }

    this.callableRegistry = createCallableRegistry({ bus: this.bus });
  }

  /**
   * `@callable` method decorators tag themselves via `ctx.addInitializer`,
   * which for a subclass runs as part of *that subclass's* own construction
   * step — after `super()` (this base constructor) has already returned. So
   * scanning can't happen in the constructor above; it's deferred to first
   * use, by which point the whole prototype chain has finished constructing.
   */
  private ensureCallablesScanned(): void {
    if (this.callablesScanned) return;
    this.callablesScanned = true;
    for (const [name, { fn, opts }] of scanCallables(this)) {
      this.callableRegistry.register(name, fn, opts);
    }
  }

  // --- dispatch tables ------------------------------------------------------

  private async dispatchSchedule(callback: string, payload: unknown, schedule: Schedule): Promise<void> {
    const internal = this.internalCallbacks.get(callback);
    if (internal) {
      await internal(payload, schedule);
      return;
    }
    if (callback.startsWith(INTERNAL_PREFIX)) {
      // An internal callback with no registered handler (e.g. the keep-alive
      // heartbeat) needs no side effect: its only job is to keep the alarm
      // armed, which the scheduler already does on every create/cancel.
      return;
    }
    const fn = (this as unknown as Record<string, unknown>)[callback];
    if (typeof fn !== "function") {
      throw new NotFoundError(`No handler for scheduled callback "${callback}"`);
    }
    await (fn as (payload: unknown, schedule: Schedule) => unknown).call(this, payload, schedule);
  }

  private async dispatchQueue(callback: string, payload: unknown, item: QueueItem): Promise<void> {
    const fn = (this as unknown as Record<string, unknown>)[callback];
    if (typeof fn !== "function") {
      throw new NotFoundError(`No handler for queued callback "${callback}"`);
    }
    await (fn as (payload: unknown, item: QueueItem) => unknown).call(this, payload, item);
  }

  /**
   * Register a scheduler callback under a `"$internal:*"` name (module-owned
   * background work, e.g. a domain service that arms its own occurrences).
   * Replaces the old pattern of dispatching internal callbacks to a real
   * (non-"$internal:"-prefixed) prototype method just so `dispatchSchedule`
   * would find a handler for them.
   */
  protected registerInternalCallback(name: string, fn: (payload: unknown) => Promise<void>): void {
    this.internalCallbacks.set(name, async (payload) => {
      await fn(payload);
    });
  }

  // --- state ------------------------------------------------------------

  get state(): State {
    return this.stateContainer.get();
  }

  /** `origin` flows into the published `state:changed` event; defaults to `{ kind: "server" }`. */
  setState(next: State, origin: StateOrigin = { kind: "server" }): void {
    const source: StateSource = {kind: origin.kind}
    // set() validates + persists + fires onStateChanged; a throwing validation
    // stops us before the publish. The container is coarse (ADR-0001), so the
    // sourceId rides on the event from here — it never enters the domain.
    this.stateContainer.set(next, source);
    this.publishStateChanged(next, origin);
  }

  /** Override to seed state the first time this agent runs (no persisted value yet). */
  protected getInitialState(): State | undefined {
    return undefined;
  }

  /** Override to reject a state change (throw). Called for both server and connection sources. */
  protected validateStateChange(_next: State, _source: StateSource): void {}

  /** Override to observe a state change after it has been persisted. */
  protected onStateChanged(_state: State, _source: StateSource): void {}

  private publishStateChanged(state: State, origin: StateOrigin): void {
    this.eventLog.publish({ type: "state:changed", state, origin });
  }

  // --- scheduling ---------------------------------------------------------

  /** Sugar: a Date (fires once at that instant), a number (delay in seconds, once), or a cron string. */
  schedule<T = unknown>(
    when: Date | number | string,
    callback: string,
    payload?: T,
    options?: { id?: string; retry?: RetryPolicy },
  ): Schedule<T> {
    return this.schedulerService.create(this.toScheduleSpec(when), callback, payload, options);
  }

  private toScheduleSpec(when: Date | number | string): ScheduleSpec {
    if (when instanceof Date) {
      return { kind: "once", at: when.getTime() };
    }
    if (typeof when === "number") {
      return { kind: "once", at: this.host.clock.now() + when * 1000 };
    }
    return { kind: "cron", expression: when };
  }

  scheduleEvery<T = unknown>(
    everySeconds: number,
    callback: string,
    payload?: T,
    options?: { id?: string; retry?: RetryPolicy },
  ): Schedule<T> {
    return this.schedulerService.create({ kind: "interval", everySeconds }, callback, payload, options);
  }

  getScheduleById<T = unknown>(id: string): Schedule<T> | undefined {
    return this.schedulerService.get<T>(id);
  }

  listSchedules<T = unknown>(criteria?: ListCriteria): Schedule<T>[] {
    return this.schedulerService.list<T>(criteria);
  }

  cancelSchedule(id: string): boolean {
    return this.schedulerService.cancel(id);
  }

  private rearmAlarm(): void {
    const next = this.schedulerService.nextWake();
    if (next === null) {
      this.host.alarm.clear();
    } else {
      this.host.alarm.set(next);
    }
  }

  // --- keep-alive -----------------------------------------------------------

  keepAlive(): () => void {
    return this.keepAliveService.acquire();
  }

  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    return this.keepAliveService.while(fn);
  }

  // --- queue ------------------------------------------------------------

  queue<T>(callback: string, payload: T): Promise<string> {
    return this.taskQueue.enqueue(callback, payload);
  }

  dequeue(id: string): void {
    this.taskQueue.dequeue(id);
  }

  dequeueAll(): void {
    this.taskQueue.dequeueAll();
  }

  dequeueAllByCallback(callback: string): void {
    this.taskQueue.dequeueAllByCallback(callback);
  }

  getQueue(id: string): QueueItem | undefined {
    return this.taskQueue.get(id);
  }

  getQueues(predicate: (item: QueueItem) => boolean): QueueItem[] {
    return this.taskQueue.find(predicate);
  }

  // --- fibers -----------------------------------------------------------

  runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T> {
    return this.fiberService.run(name, fn);
  }

  startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: { idempotencyKey?: string; metadata?: Record<string, unknown>; waitForCompletion?: boolean },
  ): Promise<StartResult> {
    return this.fiberService.start(name, fn, options);
  }

  stash(data: unknown): void {
    this.fiberService.stash(data);
  }

  inspectFiber(fiberId: string): FiberInspection | null {
    return this.fiberService.inspect(fiberId);
  }

  inspectFiberByKey(idempotencyKey: string): FiberInspection | null {
    return this.fiberService.inspectByKey(idempotencyKey);
  }

  listFibers(options?: { status?: FiberStatus[]; name?: string }): FiberInspection[] {
    return this.fiberService.list(options);
  }

  cancelFiber(fiberId: string, reason?: string): boolean {
    return this.fiberService.cancel(fiberId, reason);
  }

  cancelFiberByKey(idempotencyKey: string, reason?: string): boolean {
    return this.fiberService.cancelByKey(idempotencyKey, reason);
  }

  resolveFiber(fiberId: string, result: FiberRecoveryResult): boolean {
    return this.fiberService.resolve(fiberId, result);
  }

  deleteFibers(options?: { status?: FiberStatus[]; settledBefore?: number }): number {
    return this.fiberService.deleteFibers(options);
  }

  /** Override to resolve an orphaned managed fiber found on recovery scan. Default: leave it interrupted. */
  protected onFiberRecovered(
    _ctx: FiberRecoveryContext,
  ): void | FiberRecoveryResult | Promise<void | FiberRecoveryResult> {
    return undefined;
  }

  // --- sub-agents ---------------------------------------------------------

  private requireSubAgents(): SubAgentRegistry {
    if (!this.subAgents) {
      throw new ValidationError("No AgentSpawner configured on this host: sub-agents are unavailable");
    }
    return this.subAgents;
  }

  subAgent(className: string, name: string): AgentHandle {
    return this.requireSubAgents().get(className, name);
  }

  hasSubAgent(className: string, name: string): boolean {
    return this.subAgents?.has(className, name) ?? false;
  }

  listSubAgents(className?: string): SubAgentRecord[] {
    return this.subAgents?.list(className) ?? [];
  }

  async deleteSubAgent(className: string, name: string): Promise<void> {
    return this.requireSubAgents().delete(className, name);
  }

  abortSubAgent(className: string, name: string, reason?: unknown): void {
    this.requireSubAgents().abort(className, name, reason);
  }

  parentPath(): Array<{ className: string; name: string }> {
    return this.host.parentPath ?? [];
  }

  selfPath(): Array<{ className: string; name: string }> {
    return [...this.parentPath(), { className: this.host.className, name: this.host.name }];
  }

  /** Single-hop handle to the direct parent, via the spawner. Undefined at the root or with no spawner. */
  parentAgent(): AgentHandle | undefined {
    const path = this.parentPath();
    const parent = path[path.length - 1];
    if (!parent || !this.host.spawner) return undefined;
    return this.host.spawner.get(parent.className, parent.name);
  }

  // --- workflows ----------------------------------------------------------

  private requireWorkflows(): WorkflowService {
    if (!this.workflows) {
      throw new ValidationError("No WorkflowRuntime configured on this host: workflows are unavailable");
    }
    return this.workflows;
  }

  async runWorkflow(
    workflowName: string,
    options?: { id?: string; params?: unknown; metadata?: Record<string, unknown> },
  ): Promise<WorkflowInfo> {
    return this.requireWorkflows().run(workflowName, options);
  }

  async sendWorkflowEvent(workflowId: string, event: { type: string; payload?: unknown }): Promise<void> {
    return this.requireWorkflows().sendEvent(workflowId, event);
  }

  async approveWorkflow(workflowId: string, reason?: string): Promise<void> {
    return this.requireWorkflows().approve(workflowId, reason);
  }

  async rejectWorkflow(workflowId: string, reason?: string): Promise<void> {
    return this.requireWorkflows().reject(workflowId, reason);
  }

  async terminateWorkflow(workflowId: string): Promise<void> {
    return this.requireWorkflows().terminate(workflowId);
  }

  async pauseWorkflow(workflowId: string): Promise<void> {
    return this.requireWorkflows().pause(workflowId);
  }

  async resumeWorkflow(workflowId: string): Promise<void> {
    return this.requireWorkflows().resume(workflowId);
  }

  async restartWorkflow(workflowId: string): Promise<void> {
    return this.requireWorkflows().restart(workflowId);
  }

  async workflowStatus(workflowId: string): Promise<WorkflowInfo> {
    return this.requireWorkflows().status(workflowId);
  }

  getWorkflow(workflowId: string): WorkflowInfo | undefined {
    return this.workflows?.get(workflowId);
  }

  listWorkflows(criteria?: {
    status?: WorkflowStatus[];
    workflowName?: string;
    limit?: number;
    offset?: number;
  }): { workflows: WorkflowInfo[]; total: number } {
    return this.workflows?.list(criteria) ?? { workflows: [], total: 0 };
  }

  deleteWorkflow(workflowId: string): boolean {
    return this.workflows?.delete(workflowId) ?? false;
  }

  deleteWorkflows(criteria?: { status?: WorkflowStatus[]; updatedBefore?: number }): number {
    return this.workflows?.deleteMany(criteria) ?? 0;
  }

  migrateWorkflowBinding(oldName: string, newName: string): number {
    return this.workflows?.migrateBinding(oldName, newName) ?? 0;
  }

  async onWorkflowCallback(cb: {
    workflowId: string;
    kind: "progress" | "complete" | "error";
    payload?: unknown;
  }): Promise<{ recognized: boolean }> {
    return this.requireWorkflows().onCallback(cb);
  }

  /** Override to observe workflow progress callbacks. */
  protected onWorkflowProgress(_wf: WorkflowInfo, _payload: unknown): void | Promise<void> {}

  /** Override to observe workflow completion. */
  protected onWorkflowComplete(_wf: WorkflowInfo): void | Promise<void> {}

  // --- email ------------------------------------------------------------

  async sendEmail(message: EmailMessage): Promise<{ messageId: string }> {
    if (!this.host.email) {
      throw new ValidationError("No EmailTransport configured on this host");
    }
    const result = await this.host.email.send(message);
    this.bus.emit("email:reply", { to: message.to, messageId: result.messageId });
    return result;
  }

  /** Seam for inbound email routing (adapter/edge concern); default no-op. */
  protected onEmail(_message: EmailMessage): void | Promise<void> {}

  // --- rpc / identity -------------------------------------------------------

  callableMethods(): Map<string, CallableMetadata> {
    this.ensureCallablesScanned();
    return this.callableRegistry.callableMethods();
  }

  /** The RPC dispatch surface itself; adapters call `.dispatch(request, respond)`. */
  callables(): CallableRegistry {
    this.ensureCallablesScanned();
    return this.callableRegistry;
  }

  /** What the identity frame used to carry, minus the transport-supplied connectionId. */
  identity(): { className: string; name: string } {
    return { className: this.host.className, name: this.host.name };
  }

  // --- conversation events (audit 25 §1-2) -----------------------------------

  /** The agent's single outbound port. Adapters subscribe (from an offset, or "live"). */
  events(): ConversationEventLog {
    return this.eventLog;
  }

  /** For subclasses (Think) that need to publish without an extra indirection. */
  protected publishEvent(event: ConversationEvent): void {
    this.eventLog.publish(event);
  }

  // --- readonly policy (adapter-consulted predicate) --------------------------

  /**
   * Override to mark a connection readonly at connect time, given
   * adapter-supplied metadata (headers, auth claims, ...). Default: writable.
   * This is a plain predicate now — the agent never holds a `Connection` or
   * tracks readonly flags itself; the adapter consults this and enforces it.
   */
  protected shouldConnectionBeReadonly(_meta: Record<string, unknown>): boolean {
    return false;
  }

  // --- lifecycle ----------------------------------------------------------

  /** Adapter calls this once per activation, before routing any stimuli. */
  async start(): Promise<void> {
    await this.onStart();
    await this.fiberService.checkInterrupted();
    await this.taskQueue.flush();
    this.rearmAlarm();
  }

  /** Override for first-activation setup. Default: no-op. */
  protected onStart(): void | Promise<void> {}

  async onAlarm(): Promise<void> {
    await this.schedulerService.onAlarm();
  }

  /** HTTP seam for an adapter's router; no default routing (adapter/edge concern). */
  onRequest(_req: unknown): unknown {
    throw new NotFoundError("onRequest is not implemented");
  }

  async destroy(): Promise<void> {
    for (const s of this.schedulerService.list({ includeInternal: true })) {
      this.schedulerService.cancel(s.id);
    }
    this.host.alarm.clear();
    this.host.store.deleteAll();
    this.bus.emit("destroy", {});
    await this.host.onDestroyed?.();
  }

  get name(): string {
    return this.host.name;
  }

  get className(): string {
    return this.host.className;
  }
}
