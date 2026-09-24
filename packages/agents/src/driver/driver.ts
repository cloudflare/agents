import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../lifecycle";
import { HarnessDriverStore } from "./store";
import type {
  HarnessDriverOptions,
  HarnessDriverReceipt,
  HarnessDriverRuntime,
  HarnessDriverSubmission,
  HarnessDriverSubmitOptions
} from "./types";

const DRIVE_FN = "drive";

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
  readonly #inFlight = new Map<string, Promise<void>>();
  #store: HarnessDriverStore | undefined;

  constructor(options: HarnessDriverOptions<Input, Result>) {
    if (options.id.trim() === "") throw new Error("id must not be empty");
    super(`harness-driver:${options.id}`);
    this.#id = options.id;
    this.#runtime = options.runtime;
    this.#settle = options.settle;
    this.#fail = options.fail;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  override onStart(_context: CapabilityStartContext): void {
    const store = this.#submissionStore();
    this.lifecycle.jobs.list();
    for (const scope of store.scopes()) this.#pushScopeJob(scope, Date.now());
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
    const submission = store.get<Input>(operationId);
    if (!submission) return false;
    await this.#runtime.cancel(submission.scope, operationId);
    store.remove(operationId);
    if (store.head(submission.scope)) {
      await this.wake(submission.scope);
    } else {
      await this.lifecycle.jobs.cancel(this.#jobId(submission.scope));
    }
    return true;
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== DRIVE_FN) return;
    const scope = this.#scopeFrom(context.job.payload);
    if (!this.#inFlight.has(scope)) {
      const work = this.#driveScope(scope)
        .then((outcome) => this.#applyOutcome(scope, outcome))
        .catch((error: unknown) => {
          this.lifecycle.events.emit("driver:error", {
            scope,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => this.#inFlight.delete(scope));
      this.#inFlight.set(scope, work);
      this.lifecycle.trackAlarmWork(work);
    }
    return { rescheduleAt: Date.now() + this.#heartbeatMs };
  }

  async waitForIdle(scope?: string): Promise<void> {
    if (scope !== undefined) {
      await this.#inFlight.get(scope);
      return;
    }
    await Promise.all(this.#inFlight.values());
  }

  async #driveScope(scope: string): Promise<LifecycleJobOutcome | void> {
    const store = this.#submissionStore();
    let submission = store.admitted<Input>(scope) ?? store.head<Input>(scope);
    if (!submission) return;

    const inspection = await this.#runtime.inspect(
      scope,
      submission.operationId
    );
    if (inspection.status === "completed") {
      return this.#complete(submission, inspection.result);
    }
    if (inspection.status === "failed") {
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
      new AbortController().signal
    );
    if (outcome.status === "completed") {
      return this.#complete(submission, outcome.result);
    }
    if (outcome.status === "waiting") {
      return { rescheduleAt: outcome.notBefore };
    }
    return "yield";
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
    await this.#settle?.(submission, result);
    const store = this.#submissionStore();
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
  }

  async #failed(
    submission: HarnessDriverSubmission<Input>,
    error: { readonly name: string; readonly message: string }
  ): Promise<LifecycleJobOutcome | void> {
    await this.#fail?.(submission, error);
    const store = this.#submissionStore();
    store.remove(submission.operationId);
    return store.head(submission.scope) ? "yield" : undefined;
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
