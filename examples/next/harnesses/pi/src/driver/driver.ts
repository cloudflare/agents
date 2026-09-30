import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import { DriverStore, type StoredSubmission } from "./store";
import type {
  DriverError,
  DriverHandle,
  DriverOperation,
  DriverReceipt,
  DriverRegistrationOptions,
  DriverRuntime,
  DriverStep,
  DriverSubmission,
  DriverSubmitOptions
} from "./types";

const STEP_FN = "step";

/**
 * How long `stop()` waits for an aborted step to unwind before calling the
 * runtime's `stop`. A step that ignores its signal past this runs on, but
 * the operation is stopped and removed without waiting for it.
 */
const STOP_GRACE_MS = 5_000;

/** `onFail` threw: retry it later without stepping again. */
class OnFailError {
  constructor(readonly cause: unknown) {}
}

/** The runtime's `stop` threw: retry it later, never count toward `onFail`. */
class StopError {
  constructor(readonly cause: unknown) {}
}

type Registration<Input, Result> = {
  readonly id: string;
  readonly runtime: DriverRuntime<Input, Result>;
  readonly onFail: DriverRegistrationOptions<Input>["onFail"];
  readonly heartbeatMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  store?: DriverStore;
};

type InFlight = {
  readonly id: string;
  readonly controller: AbortController;
  readonly work: Promise<void>;
};

type Outcome = LifecycleJobOutcome | undefined;

/**
 * Copied from cloudflare/agents#2396 (`packages/agents/src/driver`, commit
 * 72b410cfd), which is based on Aron's `harness-driver` branch. Nothing here
 * has shipped in `agents`; the only change is that the published Lifecycle
 * has no `jobs.pushSync`, so `submit` pushes the queue's job before writing
 * the row instead of both in one transaction.
 *
 * Durable queues of operations, and a loop that steps each one until it is
 * done, across evictions and deploys.
 *
 * Install one `Driver` per Lifecycle Object and pass it to every harness
 * that needs it. Each harness registers its runtime under a stable id and
 * keeps the returned {@link DriverHandle}:
 *
 * ```ts
 * readonly driver = new Driver();
 * readonly harness = new MyHarness({ driver: this.driver });
 * readonly lifecycle = Lifecycle.install(this).use(this.driver).use(this.harness);
 * ```
 *
 * Every `(runtime, scope)` pair is one FIFO queue. Only the oldest
 * operation in a queue is stepped, one step at a time.
 */
export class Driver extends LifecycleCapability {
  readonly #registrations = new Map<string, Registration<unknown, unknown>>();
  readonly #inFlight = new Map<string, InFlight>();
  /**
   * Queues woken while a step was in flight. The step's own answer was
   * decided before the wake, so a `park` or `sleep` would overwrite the job
   * the wake pushed. A queue in this set steps again at once instead.
   */
  readonly #wokenInFlight = new Set<string>();
  /** Operations whose runtime `stop` is running now. */
  readonly #stopping = new Set<string>();
  #started = false;

  constructor() {
    super("driver");
  }

  /**
   * Register one runtime under a stable id and get its handle. Call it while
   * the harness is constructed, before the Lifecycle starts, so queued work
   * for this id resumes at startup. Submissions persist under the id:
   * renaming it strands them.
   */
  register<Input, Result>(
    id: string,
    runtime: DriverRuntime<Input, Result>,
    options: DriverRegistrationOptions<Input> = {}
  ): DriverHandle<Input> {
    if (id.trim() === "")
      throw new Error("Driver runtime id must not be empty");
    if (this.#registrations.has(id)) {
      throw new Error(`Driver runtime ${id} is already registered`);
    }
    const registration: Registration<Input, Result> = {
      id,
      runtime,
      onFail: options.onFail,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 3,
      retryBaseMs: options.retryBaseMs ?? 1_000,
      retryMaxMs: options.retryMaxMs ?? 30_000
    };
    if (
      !Number.isInteger(registration.maxAttempts) ||
      registration.maxAttempts < 1
    ) {
      throw new Error("maxAttempts must be a positive integer");
    }
    for (const [name, value] of [
      ["heartbeatMs", registration.heartbeatMs],
      ["retryBaseMs", registration.retryBaseMs],
      ["retryMaxMs", registration.retryMaxMs]
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number`);
      }
    }
    // SAFETY: the driver only hands a registration's stored inputs and
    // results back to that same registration's runtime and hooks.
    this.#registrations.set(
      id,
      registration as unknown as Registration<unknown, unknown>
    );
    if (this.#started) {
      this.#resume(registration).catch((error: unknown) =>
        this.#emitError(registration, undefined, error)
      );
    }

    return {
      id,
      submit: (scope, input, submitOptions) =>
        this.#submit(registration, scope, input, submitOptions),
      wake: (scope) => this.#wake(registration, scope),
      stop: (operationId) => this.#stop(registration, operationId),
      pending: (scope) => this.#pending(registration, scope),
      waitForIdle: (scope) => this.#waitForIdle(registration, scope)
    };
  }

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    this.#started = true;
    for (const registration of this.#registrations.values()) {
      await this.#resume(registration);
    }
  }

  /** This driver's queued Lifecycle jobs, one per queue with work. */
  jobs(): LifecycleJob[] {
    return this.lifecycle.jobs.list();
  }

  async onJob(context: LifecycleJobContext): Promise<Outcome | void> {
    if (context.job.fn !== STEP_FN) return;
    const { runtimeId, scope } = parsePayload(context.job.payload);
    const registration = this.#registrations.get(runtimeId);
    if (!registration) {
      // Not registered in this build. The submissions stay durable and
      // resume when a build registers the id again.
      this.lifecycle.events.emit("driver:error", {
        runtimeId,
        scope,
        error: `Driver runtime ${runtimeId} is not registered`
      });
      return;
    }
    const key = jobId(runtimeId, scope);
    if (!this.#inFlight.has(key)) {
      const head = this.#store(registration).head(scope);
      if (!head) return;
      const controller = new AbortController();
      const work = this.#run(
        registration,
        scope,
        head.id,
        controller.signal
      ).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, { id: head.id, controller, work });
      this.lifecycle.trackAlarmWork(work);
    }
    // The step runs in the background. This keeps the queue's job alive as a
    // heartbeat, so an eviction mid-step fires it again.
    return { rescheduleAt: Date.now() + registration.heartbeatMs };
  }

  // ── Handle verbs ────────────────────────────────────────────────────

  async #submit<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    input: Input,
    options: DriverSubmitOptions = {}
  ): Promise<DriverReceipt> {
    await this.lifecycle.ready();
    const id = options.id ?? crypto.randomUUID();
    const store = this.#store(registration);
    const existing = store.get<Input>(id);
    if (existing) return receipt(existing, false);

    // The published Lifecycle has no synchronous job push, so the row and
    // the job cannot share one transactionSync. Push the job first: a job
    // with an empty queue is a no-op, while a row with no job would sit
    // until the next start. See NOTES.md, "Driver needs a synchronous push".
    await this.#pushJob(registration.id, scope, Date.now());
    const result = store.enqueue(scope, id, input);
    return receipt(result.submission, result.accepted);
  }

  async #wake<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string
  ): Promise<boolean> {
    await this.lifecycle.ready();
    if (!this.#store(registration).head(scope)) return false;
    const key = jobId(registration.id, scope);
    if (this.#inFlight.has(key)) this.#wokenInFlight.add(key);
    await this.#applyOutcome(registration, scope, "yield");
    return true;
  }

  async #stop<Input, Result>(
    registration: Registration<Input, Result>,
    operationId: string
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const store = this.#store(registration);
    const operation = store.get<Input>(operationId);
    if (!operation) return false;
    store.requestStop(operationId);

    const active = this.#inFlight.get(jobId(registration.id, operation.scope));
    if (active?.id === operationId) {
      active.controller.abort(new Error("Driver operation stopped"));
      await settleWithin(active.work, STOP_GRACE_MS);
    }

    const current = store.get<Input>(operationId);
    if (!current || this.#stopping.has(operationId)) return true;
    const wasHead = store.head(current.scope)?.id === operationId;
    try {
      const outcome = await this.#stopOperation(registration, current);
      if (wasHead)
        await this.#applyOutcome(registration, current.scope, outcome);
      return true;
    } catch (error) {
      if (!(error instanceof StopError)) throw error;
      const outcome = this.#afterStopFailure(registration, current, error);
      await this.#applyOutcome(registration, current.scope, outcome);
      throw error.cause;
    }
  }

  async #pending<Input, Result>(
    registration: Registration<Input, Result>,
    scope?: string
  ): Promise<DriverSubmission<Input>[]> {
    await this.lifecycle.ready();
    return this.#store(registration)
      .list<Input>(scope)
      .map(({ failure: _failure, ...submission }) => submission);
  }

  async #waitForIdle<Input, Result>(
    registration: Registration<Input, Result>,
    scope?: string
  ): Promise<void> {
    if (scope !== undefined) {
      await this.#inFlight.get(jobId(registration.id, scope))?.work;
      return;
    }
    const prefix = jobId(registration.id, "");
    await Promise.all(
      [...this.#inFlight.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, { work }]) => work)
    );
  }

  // ── The loop ────────────────────────────────────────────────────────

  /** Step one operation once, then decide when its queue runs next. */
  async #run<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    operationId: string,
    signal: AbortSignal
  ): Promise<void> {
    const key = jobId(registration.id, scope);
    try {
      let outcome: Outcome;
      let threw = false;
      try {
        outcome = await this.#stepOnce(registration, operationId, signal);
      } catch (error) {
        threw = true;
        outcome = await this.#afterThrow(registration, operationId, error);
      }
      const woken = this.#wokenInFlight.delete(key);
      const head = this.#store(registration).head(scope);
      await this.#applyOutcome(
        registration,
        scope,
        woken && !threw && head ? "yield" : outcome
      );
    } catch (error) {
      // The queue's heartbeat job is still in place and will retry.
      this.#wokenInFlight.delete(key);
      this.#emitError(registration, scope, error);
    }
  }

  async #stepOnce<Input, Result>(
    registration: Registration<Input, Result>,
    operationId: string,
    signal: AbortSignal
  ): Promise<Outcome> {
    const store = this.#store(registration);
    const operation = store.get<Input>(operationId);
    if (!operation) return undefined;
    if (operation.failure) {
      return this.#fail(registration, operation, operation.failure);
    }
    if (operation.stopRequested) {
      if (this.#stopping.has(operationId)) return this.#heartbeat(registration);
      return this.#stopOperation(registration, operation);
    }

    store.markRunning(operationId);
    const step = validateStep(
      await registration.runtime.step(toOperation(operation), signal)
    );

    const after = store.get<Input>(operationId);
    if (!after) return nextInQueue(store, operation.scope);
    // A stop arrived during the step. `stop()` owns what happens next.
    if (after.stopRequested) return this.#heartbeat(registration);

    if (step.then === "done") {
      store.remove(operationId);
      return nextInQueue(store, operation.scope);
    }
    store.resetAttempts(operationId);
    if (step.then === "continue") return "yield";
    if (step.then === "sleep") return { rescheduleAt: step.until };
    return undefined;
  }

  async #afterThrow<Input, Result>(
    registration: Registration<Input, Result>,
    operationId: string,
    error: unknown
  ): Promise<Outcome> {
    const store = this.#store(registration);
    const operation = store.get<Input>(operationId);
    const cause =
      error instanceof OnFailError || error instanceof StopError
        ? error.cause
        : error;
    this.#emitError(registration, operation?.scope, cause);
    if (!operation) return undefined;

    if (error instanceof StopError) {
      return this.#afterStopFailure(registration, operation, error);
    }
    if (error instanceof OnFailError) {
      return this.#backoff(registration, operation.attempt + 1);
    }
    // The step threw because stop() aborted it. That is not a failure, and
    // stop() owns what happens next.
    if (operation.stopRequested) return this.#heartbeat(registration);

    const attempts = operation.attempt + 1;
    if (attempts < registration.maxAttempts) {
      store.recordAttempt(operationId, attempts, null);
      return this.#backoff(registration, attempts);
    }
    const failure = normalizeError(cause);
    store.recordAttempt(operationId, attempts, failure);
    try {
      return await this.#fail(
        registration,
        { ...operation, attempt: attempts },
        failure
      );
    } catch (onFailError) {
      this.#emitError(
        registration,
        operation.scope,
        onFailError instanceof OnFailError ? onFailError.cause : onFailError
      );
      return this.#backoff(registration, attempts + 1);
    }
  }

  async #fail<Input, Result>(
    registration: Registration<Input, Result>,
    operation: StoredSubmission<Input>,
    error: DriverError
  ): Promise<Outcome> {
    try {
      await registration.onFail?.(toOperation(operation), error);
    } catch (cause) {
      throw new OnFailError(cause);
    }
    const store = this.#store(registration);
    store.remove(operation.id);
    return nextInQueue(store, operation.scope);
  }

  async #stopOperation<Input, Result>(
    registration: Registration<Input, Result>,
    operation: StoredSubmission<Input>
  ): Promise<Outcome> {
    this.#stopping.add(operation.id);
    try {
      await registration.runtime.stop?.(toOperation(operation));
    } catch (cause) {
      throw new StopError(cause);
    } finally {
      this.#stopping.delete(operation.id);
    }
    const store = this.#store(registration);
    store.remove(operation.id);
    return nextInQueue(store, operation.scope);
  }

  #afterStopFailure<Input, Result>(
    registration: Registration<Input, Result>,
    operation: StoredSubmission<Input>,
    error: StopError
  ): Outcome {
    const attempts = operation.attempt + 1;
    this.#store(registration).recordAttempt(operation.id, attempts, null);
    this.#emitError(registration, operation.scope, error.cause);
    return this.#backoff(registration, attempts);
  }

  // ── Jobs ────────────────────────────────────────────────────────────

  async #resume<Input, Result>(
    registration: Registration<Input, Result>
  ): Promise<void> {
    const store = this.#store(registration);
    for (const scope of store.scopes()) {
      await this.#pushJob(registration.id, scope, Date.now());
    }
  }

  async #applyOutcome<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    outcome: Outcome
  ): Promise<void> {
    const id = jobId(registration.id, scope);
    if (outcome === undefined) {
      await this.lifecycle.jobs.cancel(id);
      return;
    }
    await this.lifecycle.jobs.push({
      id,
      fn: STEP_FN,
      time: outcome === "yield" ? Date.now() : outcome.rescheduleAt,
      payload: { runtimeId: registration.id, scope },
      singleflight: true,
      recoveryLoop: true
    });
  }

  async #pushJob(runtimeId: string, scope: string, time: number) {
    await this.lifecycle.jobs.push({
      id: jobId(runtimeId, scope),
      fn: STEP_FN,
      time,
      payload: { runtimeId, scope },
      singleflight: true,
      recoveryLoop: true
    });
  }

  #heartbeat<Input, Result>(registration: Registration<Input, Result>) {
    return { rescheduleAt: Date.now() + registration.heartbeatMs };
  }

  #backoff<Input, Result>(
    registration: Registration<Input, Result>,
    attempts: number
  ) {
    const multiplier = 2 ** Math.min(Math.max(attempts - 1, 0), 30);
    const delay = Math.min(
      registration.retryBaseMs * multiplier,
      registration.retryMaxMs
    );
    return { rescheduleAt: Date.now() + delay };
  }

  #store<Input, Result>(
    registration: Registration<Input, Result>
  ): DriverStore {
    registration.store ??= new DriverStore(
      this.lifecycle.storage,
      registration.id
    );
    registration.store.ensureTable();
    return registration.store;
  }

  #emitError<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string | undefined,
    error: unknown
  ): void {
    this.lifecycle.events.emit("driver:error", {
      runtimeId: registration.id,
      scope,
      error: normalizeError(error).message
    });
  }
}

function jobId(runtimeId: string, scope: string): string {
  return `driver:${runtimeId.length}:${runtimeId}:${scope}`;
}

function parsePayload(payload: unknown): { runtimeId: string; scope: string } {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("runtimeId" in payload) ||
    typeof payload.runtimeId !== "string" ||
    !("scope" in payload) ||
    typeof payload.scope !== "string"
  ) {
    throw new Error("Invalid driver job payload");
  }
  return { runtimeId: payload.runtimeId, scope: payload.scope };
}

function nextInQueue(store: DriverStore, scope: string): Outcome {
  return store.head(scope) ? "yield" : undefined;
}

function toOperation<Input>(
  submission: StoredSubmission<Input>
): DriverOperation<Input> {
  return {
    scope: submission.scope,
    id: submission.id,
    input: submission.input,
    attempt: submission.attempt
  };
}

function validateStep<Result>(step: DriverStep<Result>): DriverStep<Result> {
  switch (step?.then) {
    case "continue":
    case "park":
    case "done":
      return step;
    case "sleep":
      if (Number.isFinite(step.until)) return step;
      throw new TypeError("A sleep step needs a finite `until` time");
    default:
      throw new TypeError("A step must return continue, sleep, park or done");
  }
}

function receipt(
  submission: StoredSubmission,
  accepted: boolean
): DriverReceipt {
  return {
    id: submission.id,
    scope: submission.scope,
    accepted,
    submittedAt: submission.submittedAt
  };
}

function normalizeError(error: unknown): DriverError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    })
  ]);
  clearTimeout(timer);
}
