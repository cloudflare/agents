import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../lifecycle";
import { DriverStore } from "./store";
import type {
  DriverCancellation,
  DriverError,
  DriverHandle,
  DriverReceipt,
  DriverRegistrationOptions,
  DriverRuntime,
  DriverSubmission,
  DriverSubmitOptions
} from "./types";

const DRIVE_FN = "drive";

class SettlementError {
  constructor(readonly cause: unknown) {}
}

type Registration<Input, Result> = {
  readonly id: string;
  readonly runtime: DriverRuntime<Input, Result>;
  readonly settle: DriverRegistrationOptions<Input, Result>["settle"];
  readonly fail: DriverRegistrationOptions<Input, Result>["fail"];
  readonly heartbeatMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  store?: DriverStore;
};

type InFlight = {
  readonly operationId: string;
  readonly controller: AbortController;
  readonly work: Promise<void>;
};

/**
 * Durable submission queues and a wake loop for harness runtimes.
 *
 * Install one `Driver` per Lifecycle Object and pass it to every harness
 * that needs it. Each harness registers its runtime under a stable id and
 * keeps the returned {@link DriverHandle}; the host only installs the
 * capability:
 *
 * ```ts
 * readonly driver = new Driver();
 * readonly harness = new PiHarness({ driver: this.driver, streams: this.streams });
 * readonly lifecycle = Lifecycle.install(this)
 *   .use(this.streams)
 *   .use(this.driver)
 *   .use(this.harness);
 * ```
 *
 * Each `(runtime, scope)` pair is one FIFO queue with at most one admitted
 * submission, driven by one singleflight Lifecycle job.
 */
export class Driver extends LifecycleCapability {
  readonly #registrations = new Map<string, Registration<unknown, unknown>>();
  readonly #inFlight = new Map<string, InFlight>();
  /**
   * Queues woken while a drive was in flight. The drive's own outcome is
   * computed from what it saw before the wake, so a park or a later
   * reschedule would overwrite the job the wake pushed. A queue in this set
   * drives again at once instead.
   */
  readonly #wokenInFlight = new Set<string>();
  #started = false;

  constructor() {
    super("driver");
  }

  /**
   * Register one runtime under a stable id. Call it while the harness is
   * constructed, before the Lifecycle starts: queued work for this id is
   * resumed at startup. Submissions persist under the id, so renaming it
   * orphans them.
   */
  register<Input, Result>(
    id: string,
    runtime: DriverRuntime<Input, Result>,
    options: DriverRegistrationOptions<Input, Result> = {}
  ): DriverHandle<Input> {
    if (id.trim() === "")
      throw new Error("Driver runtime id must not be empty");
    if (this.#registrations.has(id)) {
      throw new Error(`Driver runtime ${id} is already registered`);
    }
    const registration: Registration<Input, Result> = {
      id,
      runtime,
      settle: options.settle,
      fail: options.fail,
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
    if (
      !Number.isFinite(registration.retryBaseMs) ||
      registration.retryBaseMs < 0
    ) {
      throw new Error("retryBaseMs must be a non-negative number");
    }
    if (
      !Number.isFinite(registration.retryMaxMs) ||
      registration.retryMaxMs < 0
    ) {
      throw new Error("retryMaxMs must be a non-negative number");
    }
    // SAFETY: a registration is only ever read back by the driver itself,
    // which passes the stored input and result straight back to the same
    // runtime and hooks that produced their types.
    this.#registrations.set(
      id,
      registration as unknown as Registration<unknown, unknown>
    );
    if (this.#started) void this.#resume(registration);

    return {
      id,
      submit: (scope, input, submitOptions) =>
        this.#submit(registration, scope, input, submitOptions),
      pending: (scope) => this.#pending(registration, scope),
      wake: (scope) => this.#wake(registration, scope),
      defer: (scope, time) => this.#defer(registration, scope, time),
      cancel: (operationId) => this.#cancel(registration, operationId),
      waitForIdle: (scope) => this.#waitForIdle(registration, scope)
    };
  }

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    this.#started = true;
    for (const registration of this.#registrations.values()) {
      await this.#resume(registration);
    }
  }

  /** This driver's queued jobs. */
  jobs(): LifecycleJob[] {
    return this.lifecycle.jobs.list();
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== DRIVE_FN) return;
    const { runtimeId, scope } = this.#payload(context.job.payload);
    const registration = this.#registrations.get(runtimeId);
    if (!registration) {
      // The runtime is not registered in this build. Its submissions stay
      // durable and resume when it is registered again.
      this.lifecycle.events.emit("driver:error", {
        runtimeId,
        scope,
        error: `Driver runtime ${runtimeId} is not registered`
      });
      return;
    }
    const key = this.#jobId(runtimeId, scope);
    if (!this.#inFlight.has(key)) {
      const store = this.#store(registration);
      const submission = store.admitted(scope) ?? store.head(scope);
      if (!submission) return;
      const controller = new AbortController();
      const work = this.#runScope(
        registration,
        scope,
        controller.signal
      ).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, {
        operationId: submission.operationId,
        controller,
        work
      });
      this.lifecycle.trackAlarmWork(work);
    }
    return { rescheduleAt: Date.now() + registration.heartbeatMs };
  }

  async #resume<Input, Result>(
    registration: Registration<Input, Result>
  ): Promise<void> {
    const store = this.#store(registration);
    this.lifecycle.jobs.list();
    for (const scope of store.scopes()) {
      this.#pushScopeJob(registration.id, scope, Date.now());
    }
    await this.lifecycle.jobs.rearm();
  }

  async #submit<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    input: Input,
    options: DriverSubmitOptions = {}
  ): Promise<DriverReceipt> {
    await this.lifecycle.ready();
    const operationId = options.operationId ?? crypto.randomUUID();
    const store = this.#store(registration);
    this.lifecycle.jobs.list();
    const existing = store.get<Input>(operationId);
    if (existing) return this.#receipt(existing, false);

    const result = this.lifecycle.storage.transactionSync(() => {
      const enqueued = store.enqueue(
        scope,
        operationId,
        input,
        options.streamId ?? null
      );
      this.#pushScopeJob(
        registration.id,
        enqueued.submission.scope,
        Date.now()
      );
      return enqueued;
    });
    await this.lifecycle.jobs.rearm();
    return this.#receipt(result.submission, result.accepted);
  }

  async #pending<Input, Result>(
    registration: Registration<Input, Result>,
    scope?: string
  ): Promise<DriverSubmission<Input>[]> {
    await this.lifecycle.ready();
    return this.#store(registration).list<Input>(scope);
  }

  async #defer<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    time: number
  ): Promise<boolean> {
    await this.lifecycle.ready();
    return this.lifecycle.jobs.reschedule(
      this.#jobId(registration.id, scope),
      time
    );
  }

  async #wake<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string
  ): Promise<boolean> {
    await this.lifecycle.ready();
    if (!this.#store(registration).head(scope)) return false;
    const key = this.#jobId(registration.id, scope);
    if (this.#inFlight.has(key)) this.#wokenInFlight.add(key);
    await this.lifecycle.jobs.push({
      id: key,
      fn: DRIVE_FN,
      time: Date.now(),
      payload: { runtimeId: registration.id, scope },
      singleflight: true,
      recoveryLoop: true
    });
    return true;
  }

  async #cancel<Input, Result>(
    registration: Registration<Input, Result>,
    operationId: string
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const store = this.#store(registration);
    let submission = store.get<Input>(operationId);
    if (!submission) return false;
    submission = store.requestCancellation<Input>(operationId) ?? submission;
    const active = this.#inFlight.get(
      this.#jobId(registration.id, submission.scope)
    );
    if (active?.operationId === operationId) active.controller.abort();
    try {
      const cancelled = await registration.runtime.cancel(
        submission.scope,
        submission.operationId
      );
      await this.#applyOutcome(
        registration,
        submission.scope,
        await this.#cancellationOutcome(registration, submission, cancelled)
      );
      return true;
    } catch (error) {
      await this.#retryCancellation(registration, submission, error);
      throw error;
    }
  }

  async #waitForIdle<Input, Result>(
    registration: Registration<Input, Result>,
    scope?: string
  ): Promise<void> {
    if (scope !== undefined) {
      await this.#inFlight.get(this.#jobId(registration.id, scope))?.work;
      return;
    }
    const prefix = this.#jobId(registration.id, "");
    await Promise.all(
      [...this.#inFlight.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, { work }]) => work)
    );
  }

  async #driveScope<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    signal: AbortSignal
  ): Promise<LifecycleJobOutcome | void> {
    const { runtime } = registration;
    const store = this.#store(registration);
    let submission = store.admitted<Input>(scope) ?? store.head<Input>(scope);
    if (!submission) return;
    if (submission.failure) {
      return this.#failed(registration, submission, submission.failure);
    }
    if (submission.cancelRequested) {
      const cancelled = await runtime.cancel(scope, submission.operationId);
      return this.#cancellationOutcome(registration, submission, cancelled);
    }

    const inspection = await runtime.inspect(scope, submission.operationId);
    if (inspection.status === "completed") {
      return this.#complete(registration, submission, inspection.result);
    }
    if (inspection.status === "failed") {
      submission =
        store.recordAttempt<Input>(
          submission.operationId,
          submission.attempts,
          inspection.error
        ) ?? submission;
      return this.#failed(registration, submission, inspection.error);
    }
    if (inspection.status === "waiting") {
      return inspection.notBefore === undefined
        ? undefined
        : { rescheduleAt: inspection.notBefore };
    }
    if (inspection.status === "not-admitted") {
      await runtime.admit(scope, submission.operationId, submission.input);
    }
    if (submission.status === "queued") {
      submission =
        store.markAdmitted<Input>(submission.operationId) ?? submission;
    }

    const outcome = await runtime.drive(scope, submission.operationId, signal);
    if (outcome.status === "completed") {
      return this.#complete(registration, submission, outcome.result);
    }
    store.resetAttempts(submission.operationId);
    if (outcome.status === "waiting") {
      return outcome.notBefore === undefined
        ? undefined
        : { rescheduleAt: outcome.notBefore };
    }
    return "yield";
  }

  async #runScope<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    signal: AbortSignal
  ): Promise<void> {
    const key = this.#jobId(registration.id, scope);
    try {
      const outcome = await this.#driveScope(registration, scope, signal);
      const woken = this.#wokenInFlight.delete(key);
      await this.#applyOutcome(
        registration,
        scope,
        woken && this.#store(registration).head(scope) ? "yield" : outcome
      );
    } catch (error) {
      this.#wokenInFlight.delete(key);
      await this.#recoverFromError(registration, scope, error);
    }
  }

  async #recoverFromError<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    error: unknown
  ): Promise<void> {
    const cause = error instanceof SettlementError ? error.cause : error;
    const normalized = normalizeError(cause);
    this.lifecycle.events.emit("driver:error", {
      runtimeId: registration.id,
      scope,
      error: normalized.message
    });
    const store = this.#store(registration);
    let submission = store.admitted<Input>(scope) ?? store.head<Input>(scope);
    if (!submission) {
      await this.#applyOutcome(registration, scope, undefined);
      return;
    }
    if (submission.cancelRequested) {
      await this.#retryCancellation(registration, submission, cause);
      return;
    }
    if (error instanceof SettlementError || submission.failure) {
      await this.#scheduleRetry(registration, scope, submission.attempts + 1);
      return;
    }
    const attempts = submission.attempts + 1;
    if (attempts < registration.maxAttempts) {
      store.recordAttempt(submission.operationId, attempts, null);
      await this.#scheduleRetry(registration, scope, attempts);
      return;
    }
    submission =
      store.recordAttempt<Input>(
        submission.operationId,
        attempts,
        normalized
      ) ?? submission;
    try {
      await this.#applyOutcome(
        registration,
        scope,
        await this.#failed(registration, submission, normalized)
      );
    } catch (settlementError) {
      const failure =
        settlementError instanceof SettlementError
          ? settlementError.cause
          : settlementError;
      this.lifecycle.events.emit("driver:error", {
        runtimeId: registration.id,
        scope,
        error: normalizeError(failure).message
      });
      await this.#scheduleRetry(registration, scope, attempts + 1);
    }
  }

  async #retryCancellation<Input, Result>(
    registration: Registration<Input, Result>,
    submission: DriverSubmission<Input>,
    error: unknown
  ): Promise<void> {
    const attempts = submission.attempts + 1;
    this.#store(registration).recordAttempt(
      submission.operationId,
      attempts,
      null
    );
    this.lifecycle.events.emit("driver:error", {
      runtimeId: registration.id,
      scope: submission.scope,
      error: normalizeError(error).message
    });
    await this.#scheduleRetry(registration, submission.scope, attempts);
  }

  async #scheduleRetry<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    attempts: number
  ): Promise<void> {
    const multiplier = 2 ** Math.min(Math.max(attempts - 1, 0), 30);
    const delay = Math.min(
      registration.retryBaseMs * multiplier,
      registration.retryMaxMs
    );
    await this.#applyOutcome(registration, scope, {
      rescheduleAt: Date.now() + delay
    });
  }

  #cancellationOutcome<Input, Result>(
    registration: Registration<Input, Result>,
    submission: DriverSubmission<Input>,
    cancellation: DriverCancellation<Result>
  ): LifecycleJobOutcome | Promise<LifecycleJobOutcome | void> | void {
    if (cancellation.status === "completed") {
      return this.#complete(registration, submission, cancellation.result);
    }
    if (cancellation.status === "pending") {
      return {
        rescheduleAt:
          cancellation.notBefore ?? Date.now() + registration.heartbeatMs
      };
    }
    const store = this.#store(registration);
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  async #applyOutcome<Input, Result>(
    registration: Registration<Input, Result>,
    scope: string,
    outcome: LifecycleJobOutcome | void
  ): Promise<void> {
    const id = this.#jobId(registration.id, scope);
    if (outcome === undefined) {
      await this.lifecycle.jobs.cancel(id);
      return;
    }
    await this.lifecycle.jobs.push({
      id,
      fn: DRIVE_FN,
      time: outcome === "yield" ? Date.now() : outcome.rescheduleAt,
      payload: { runtimeId: registration.id, scope },
      singleflight: true,
      recoveryLoop: true
    });
  }

  async #complete<Input, Result>(
    registration: Registration<Input, Result>,
    submission: DriverSubmission<Input>,
    result: Result
  ): Promise<LifecycleJobOutcome | void> {
    try {
      await registration.settle?.(submission, result);
    } catch (error) {
      throw new SettlementError(error);
    }
    const store = this.#store(registration);
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  async #failed<Input, Result>(
    registration: Registration<Input, Result>,
    submission: DriverSubmission<Input>,
    error: DriverError
  ): Promise<LifecycleJobOutcome | void> {
    try {
      await registration.fail?.(submission, error);
    } catch (failure) {
      throw new SettlementError(failure);
    }
    const store = this.#store(registration);
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  #payload(payload: unknown): { runtimeId: string; scope: string } {
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

  #pushScopeJob(runtimeId: string, scope: string, time: number): void {
    this.lifecycle.jobs.pushSync({
      id: this.#jobId(runtimeId, scope),
      fn: DRIVE_FN,
      time,
      payload: { runtimeId, scope },
      singleflight: true,
      recoveryLoop: true
    });
  }

  #jobId(runtimeId: string, scope: string): string {
    return `driver:${runtimeId.length}:${runtimeId}:${scope}`;
  }

  #receipt(submission: DriverSubmission, accepted: boolean): DriverReceipt {
    return {
      operationId: submission.operationId,
      scope: submission.scope,
      accepted,
      submittedAt: submission.submittedAt
    };
  }
}

function normalizeError(error: unknown): DriverError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
