import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";

/**
 * A capability for job-queue tests: it records each dispatch, can be told
 * to throw, and exposes its jobs. New lifecycle tests use this rather than
 * their own copy.
 */
export class TestJobs extends LifecycleCapability {
  /** Ids of the jobs it ran, in order; may be shared between owners. */
  readonly ran: string[];
  /** The attempt number of each dispatch. */
  readonly attempts: number[] = [];
  /** Terminal failures it was told about (with `recordFailures`). */
  readonly failures: { attempt: number; name: string }[] = [];
  /** Set: every dispatch throws this. */
  failWith: (() => Error) | undefined;
  readonly #onJob: ((context: LifecycleJobContext) => void) | undefined;

  constructor(
    id: string,
    options: {
      ran?: string[];
      /** Runs in each dispatch, after it is recorded; may throw. */
      onJob?: (context: LifecycleJobContext) => void;
      /** Install an `onJobError` hook that records the failure. */
      recordFailures?: boolean;
    } = {}
  ) {
    super(id);
    this.ran = options.ran ?? [];
    this.#onJob = options.onJob;
    if (options.recordFailures) {
      // An owner's hook changes how the driver gives a job up, so only the
      // tests that ask for it get one.
      Object.defineProperty(this, "onJobError", {
        value: ({ attempt }: LifecycleJobContext, error: unknown) => {
          this.failures.push({
            attempt,
            name: error instanceof Error ? error.name : String(error)
          });
        }
      });
    }
  }

  onJob(context: LifecycleJobContext): void {
    this.ran.push(context.job.id);
    this.attempts.push(context.attempt);
    this.#onJob?.(context);
    if (this.failWith) throw this.failWith();
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }

  get(id: string) {
    return this.lifecycle.jobs.get(id);
  }

  cancel(id: string) {
    return this.lifecycle.jobs.cancel(id);
  }

  reschedule(id: string, time: number) {
    return this.lifecycle.jobs.reschedule(id, time);
  }
}
