import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../lifecycle";
import { HarnessDriverStore } from "./store";
import type {
  HarnessDriverCancellation,
  HarnessDriverError,
  HarnessDriverOptions,
  HarnessDriverReceipt,
  HarnessDriverRuntime,
  HarnessDriverSubmission,
  HarnessDriverSubmitOptions
} from "./types";

const DRIVE_FN = "drive";

class HarnessSettlementError {
  constructor(readonly cause: unknown) {}
}

export class HarnessDriver<Input, Result> extends LifecycleCapability {
  readonly #id: string;
  readonly #runtime: HarnessDriverRuntime<Input, Result>;
  readonly #settle:
    | ((
        submission: HarnessDriverSubmission<Input>,
        result: Result
      ) => void | Promise<void>)
    | undefined;
  readonly #fail:
    | ((
        submission: HarnessDriverSubmission<Input>,
        error: { readonly name: string; readonly message: string }
      ) => void | Promise<void>)
    | undefined;
  readonly #heartbeatMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #inFlight = new Map<
    string,
    {
      readonly operationId: string;
      readonly controller: AbortController;
      readonly work: Promise<void>;
    }
  >();
  #store: HarnessDriverStore | undefined;

  constructor(options: HarnessDriverOptions<Input, Result>) {
    if (options.id.trim() === "") throw new Error("id must not be empty");
    super(`harness-driver:${options.id}`);
    this.#id = options.id;
    this.#runtime = options.runtime;
    this.#settle = options.settle;
    this.#fail = options.fail;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
    this.#retryMaxMs = options.retryMaxMs ?? 30_000;
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(this.#retryBaseMs) || this.#retryBaseMs < 0) {
      throw new Error("retryBaseMs must be a non-negative number");
    }
    if (!Number.isFinite(this.#retryMaxMs) || this.#retryMaxMs < 0) {
      throw new Error("retryMaxMs must be a non-negative number");
    }
  }

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const store = this.#submissionStore();
    this.lifecycle.jobs.list();
    for (const scope of store.scopes()) this.#pushScopeJob(scope, Date.now());
    await this.lifecycle.jobs.rearm();
  }

  async submit(
    scope: string,
    input: Input,
    options: HarnessDriverSubmitOptions = {}
  ): Promise<HarnessDriverReceipt> {
    await this.lifecycle.ready();
    const operationId = options.operationId ?? crypto.randomUUID();
    const store = this.#submissionStore();
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
      this.#pushScopeJob(enqueued.submission.scope, Date.now());
      return enqueued;
    });
    await this.lifecycle.jobs.rearm();
    return this.#receipt(result.submission, result.accepted);
  }

  async pending(scope?: string): Promise<HarnessDriverSubmission<Input>[]> {
    await this.lifecycle.ready();
    return this.#submissionStore().list<Input>(scope);
  }

  jobs(): LifecycleJob[] {
    return this.lifecycle.jobs.list();
  }

  async defer(scope: string, time: number): Promise<boolean> {
    await this.lifecycle.ready();
    return this.lifecycle.jobs.reschedule(this.#jobId(scope), time);
  }

  async wake(scope: string): Promise<boolean> {
    await this.lifecycle.ready();
    const store = this.#submissionStore();
    if (!store.head(scope)) return false;
    await this.lifecycle.jobs.push({
      id: this.#jobId(scope),
      fn: DRIVE_FN,
      time: Date.now(),
      payload: { scope },
      singleflight: true,
      recoveryLoop: true
    });
    return true;
  }

  async cancel(operationId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const store = this.#submissionStore();
    let submission = store.get<Input>(operationId);
    if (!submission) return false;
    submission = store.requestCancellation<Input>(operationId) ?? submission;
    const active = this.#inFlight.get(submission.scope);
    if (active?.operationId === operationId) active.controller.abort();
    try {
      const cancelled = await this.#runtime.cancel(
        submission.scope,
        operationId
      );
      await this.#applyOutcome(
        submission.scope,
        await this.#cancellationOutcome(submission, cancelled)
      );
      return true;
    } catch (error) {
      await this.#retryCancellation(submission, error);
      throw error;
    }
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== DRIVE_FN) return;
    const scope = this.#scopeFrom(context.job.payload);
    if (!this.#inFlight.has(scope)) {
      const submission =
        this.#submissionStore().admitted<Input>(scope) ??
        this.#submissionStore().head<Input>(scope);
      if (!submission) return;
      const controller = new AbortController();
      const work = this.#runScope(scope, controller.signal).finally(() =>
        this.#inFlight.delete(scope)
      );
      this.#inFlight.set(scope, {
        operationId: submission.operationId,
        controller,
        work
      });
      this.lifecycle.trackAlarmWork(work);
    }
    return { rescheduleAt: Date.now() + this.#heartbeatMs };
  }

  async waitForIdle(scope?: string): Promise<void> {
    if (scope !== undefined) {
      await this.#inFlight.get(scope)?.work;
      return;
    }
    await Promise.all([...this.#inFlight.values()].map(({ work }) => work));
  }

  async #driveScope(
    scope: string,
    signal: AbortSignal
  ): Promise<LifecycleJobOutcome | void> {
    const store = this.#submissionStore();
    let submission = store.admitted<Input>(scope) ?? store.head<Input>(scope);
    if (!submission) return;
    if (submission.failure) {
      return this.#failed(submission, submission.failure);
    }
    if (submission.cancelRequested) {
      const cancelled = await this.#runtime.cancel(
        scope,
        submission.operationId
      );
      return this.#cancellationOutcome(submission, cancelled);
    }

    const inspection = await this.#runtime.inspect(
      scope,
      submission.operationId
    );
    if (inspection.status === "completed") {
      return this.#complete(submission, inspection.result);
    }
    if (inspection.status === "failed") {
      submission =
        (store.recordAttempt(
          submission.operationId,
          submission.attempts,
          inspection.error
        ) as HarnessDriverSubmission<Input> | undefined) ?? submission;
      return this.#failed(submission, inspection.error);
    }
    if (inspection.status === "waiting") {
      return {
        rescheduleAt: inspection.notBefore ?? Date.now() + this.#heartbeatMs
      };
    }
    if (inspection.status === "not-admitted") {
      await this.#runtime.admit(
        scope,
        submission.operationId,
        submission.input
      );
    }
    if (submission.status === "queued") {
      submission =
        store.markAdmitted<Input>(submission.operationId) ?? submission;
    }

    const outcome = await this.#runtime.drive(
      scope,
      submission.operationId,
      signal
    );
    if (outcome.status === "completed") {
      return this.#complete(submission, outcome.result);
    }
    store.resetAttempts(submission.operationId);
    if (outcome.status === "waiting") {
      return { rescheduleAt: outcome.notBefore };
    }
    return "yield";
  }

  async #runScope(scope: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#applyOutcome(scope, await this.#driveScope(scope, signal));
    } catch (error) {
      await this.#recoverFromError(scope, error);
    }
  }

  async #recoverFromError(scope: string, error: unknown): Promise<void> {
    const cause = error instanceof HarnessSettlementError ? error.cause : error;
    const normalized = this.#normalizeError(cause);
    this.lifecycle.events.emit("driver:error", {
      driverId: this.#id,
      scope,
      error: normalized.message
    });
    const store = this.#submissionStore();
    let submission = store.admitted<Input>(scope) ?? store.head<Input>(scope);
    if (!submission) {
      await this.#applyOutcome(scope, undefined);
      return;
    }
    if (submission.cancelRequested) {
      await this.#retryCancellation(submission, cause);
      return;
    }
    if (error instanceof HarnessSettlementError || submission.failure) {
      await this.#scheduleRetry(scope, submission.attempts + 1);
      return;
    }
    const attempts = submission.attempts + 1;
    if (attempts < this.#maxAttempts) {
      store.recordAttempt(submission.operationId, attempts, null);
      await this.#scheduleRetry(scope, attempts);
      return;
    }
    submission =
      (store.recordAttempt(submission.operationId, attempts, normalized) as
        | HarnessDriverSubmission<Input>
        | undefined) ?? submission;
    try {
      await this.#applyOutcome(
        scope,
        await this.#failed(submission, normalized)
      );
    } catch (settlementError) {
      const failure =
        settlementError instanceof HarnessSettlementError
          ? settlementError.cause
          : settlementError;
      this.lifecycle.events.emit("driver:error", {
        driverId: this.#id,
        scope,
        error: this.#normalizeError(failure).message
      });
      await this.#scheduleRetry(scope, attempts + 1);
    }
  }

  async #retryCancellation(
    submission: HarnessDriverSubmission<Input>,
    error: unknown
  ): Promise<void> {
    const attempts = submission.attempts + 1;
    this.#submissionStore().recordAttempt(
      submission.operationId,
      attempts,
      null
    );
    this.lifecycle.events.emit("driver:error", {
      driverId: this.#id,
      scope: submission.scope,
      error: this.#normalizeError(error).message
    });
    await this.#scheduleRetry(submission.scope, attempts);
  }

  async #scheduleRetry(scope: string, attempts: number): Promise<void> {
    const multiplier = 2 ** Math.min(Math.max(attempts - 1, 0), 30);
    const delay = Math.min(this.#retryBaseMs * multiplier, this.#retryMaxMs);
    await this.#applyOutcome(scope, { rescheduleAt: Date.now() + delay });
  }

  #cancellationOutcome(
    submission: HarnessDriverSubmission<Input>,
    cancellation: HarnessDriverCancellation<Result>
  ): LifecycleJobOutcome | Promise<LifecycleJobOutcome | void> | void {
    if (cancellation.status === "completed") {
      return this.#complete(submission, cancellation.result);
    }
    if (cancellation.status === "pending") {
      return {
        rescheduleAt: cancellation.notBefore ?? Date.now() + this.#heartbeatMs
      };
    }
    const store = this.#submissionStore();
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  async #applyOutcome(
    scope: string,
    outcome: LifecycleJobOutcome | void
  ): Promise<void> {
    if (outcome === undefined) {
      await this.lifecycle.jobs.cancel(this.#jobId(scope));
      return;
    }
    await this.lifecycle.jobs.push({
      id: this.#jobId(scope),
      fn: DRIVE_FN,
      time: outcome === "yield" ? Date.now() : outcome.rescheduleAt,
      payload: { scope },
      singleflight: true,
      recoveryLoop: true
    });
  }

  async #complete(
    submission: HarnessDriverSubmission<Input>,
    result: Result
  ): Promise<LifecycleJobOutcome | void> {
    try {
      await this.#settle?.(submission, result);
    } catch (error) {
      throw new HarnessSettlementError(error);
    }
    const store = this.#submissionStore();
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  async #failed(
    submission: HarnessDriverSubmission<Input>,
    error: { readonly name: string; readonly message: string }
  ): Promise<LifecycleJobOutcome | void> {
    try {
      await this.#fail?.(submission, error);
    } catch (failure) {
      throw new HarnessSettlementError(failure);
    }
    const store = this.#submissionStore();
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  #normalizeError(error: unknown): HarnessDriverError {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "Error", message: String(error) };
  }

  #scopeFrom(payload: unknown): string {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("scope" in payload) ||
      typeof payload.scope !== "string"
    ) {
      throw new Error("Invalid harness driver job payload");
    }
    return payload.scope;
  }

  #submissionStore(): HarnessDriverStore {
    this.#store ??= new HarnessDriverStore(this.lifecycle.storage, this.#id);
    this.#store.ensureTable();
    return this.#store;
  }

  #pushScopeJob(scope: string, time: number): void {
    this.lifecycle.jobs.pushSync({
      id: this.#jobId(scope),
      fn: DRIVE_FN,
      time,
      payload: { scope },
      singleflight: true,
      recoveryLoop: true
    });
  }

  #jobId(scope: string): string {
    return `harness:${this.#id.length}:${this.#id}:${scope}`;
  }

  #receipt(
    submission: HarnessDriverSubmission,
    accepted: boolean
  ): HarnessDriverReceipt {
    return {
      operationId: submission.operationId,
      scope: submission.scope,
      accepted,
      submittedAt: submission.submittedAt
    };
  }
}
