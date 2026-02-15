import { Agent, callable, type RetryOptions } from "../../index.ts";

/**
 * Test agent with default static options (no retry override).
 * Uses the framework defaults: maxAttempts 3, baseDelayMs 100, maxDelayMs 3000.
 *
 * Methods that test error paths catch errors internally and return them as
 * `{ error: string }` results. This avoids unhandled promise rejections in
 * the workerd runtime — thrown errors in @callable methods cross the RPC
 * boundary and appear as uncaught rejections to the runtime even when the
 * test correctly uses .rejects.toThrow().
 */
export class TestRetryAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  // ── this.retry() ─────────────────────────────────────────────────

  @callable()
  async retrySucceedsOnAttempt(succeedOn: number): Promise<{
    result: string;
    attempts: number[];
  }> {
    const attempts: number[] = [];
    const result = await this.retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < succeedOn) {
          throw new Error(`transient-${attempt}`);
        }
        return `ok-${attempt}`;
      },
      { baseDelayMs: 1, maxDelayMs: 10 }
    );
    return { result, attempts };
  }

  @callable()
  async retryExhausted(): Promise<{ error: string }> {
    try {
      await this.retry(
        async (attempt) => {
          throw new Error(`always-fail-${attempt}`);
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 }
      );
      return { error: "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async retryWithShouldRetry(
    failCount: number,
    permanent: boolean
  ): Promise<{ result: string; attempts: number[]; error: string }> {
    const attempts: number[] = [];
    try {
      const result = await this.retry(
        async (attempt) => {
          attempts.push(attempt);
          if (attempt <= failCount) {
            const err = new Error(
              `${permanent ? "permanent" : "transient"}-${attempt}`
            );
            (err as unknown as { permanent: boolean }).permanent = permanent;
            throw err;
          }
          return `ok-${attempt}`;
        },
        {
          maxAttempts: 10,
          baseDelayMs: 1,
          maxDelayMs: 10,
          shouldRetry: (err) => {
            return !(err as { permanent?: boolean }).permanent;
          }
        }
      );
      return { result, attempts, error: "" };
    } catch (e) {
      return { result: "", attempts, error: (e as Error).message };
    }
  }

  // ── queue() with retry ───────────────────────────────────────────

  queueCallbackAttempts = 0;
  queueCallbackResult: string | null = null;

  @callable()
  async enqueueWithRetry(
    succeedOnAttempt: number,
    retryOpts: RetryOptions
  ): Promise<string> {
    this.queueCallbackAttempts = 0;
    this.queueCallbackResult = null;
    return this.queue(
      "onQueueCallback",
      { succeedOnAttempt },
      { retry: retryOpts }
    );
  }

  async onQueueCallback(payload: { succeedOnAttempt: number }) {
    this.queueCallbackAttempts++;
    if (this.queueCallbackAttempts < payload.succeedOnAttempt) {
      throw new Error(`queue-fail-${this.queueCallbackAttempts}`);
    }
    this.queueCallbackResult = `queue-ok-${this.queueCallbackAttempts}`;
  }

  @callable()
  getQueueCallbackResult(): {
    attempts: number;
    result: string | null;
  } {
    return {
      attempts: this.queueCallbackAttempts,
      result: this.queueCallbackResult
    };
  }

  // ── schedule() with retry ────────────────────────────────────────

  scheduleCallbackAttempts = 0;
  scheduleCallbackResult: string | null = null;

  @callable()
  async scheduleWithRetry(
    succeedOnAttempt: number,
    retryOpts: RetryOptions
  ): Promise<string> {
    this.scheduleCallbackAttempts = 0;
    this.scheduleCallbackResult = null;
    const schedule = await this.schedule(
      0,
      "onScheduleCallback",
      { succeedOnAttempt },
      { retry: retryOpts }
    );
    return schedule.id;
  }

  async onScheduleCallback(payload: { succeedOnAttempt: number }) {
    this.scheduleCallbackAttempts++;
    if (this.scheduleCallbackAttempts < payload.succeedOnAttempt) {
      throw new Error(`schedule-fail-${this.scheduleCallbackAttempts}`);
    }
    this.scheduleCallbackResult = `schedule-ok-${this.scheduleCallbackAttempts}`;
  }

  @callable()
  getScheduleCallbackResult(): {
    attempts: number;
    result: string | null;
  } {
    return {
      attempts: this.scheduleCallbackAttempts,
      result: this.scheduleCallbackResult
    };
  }

  // ── queue/schedule with retry options persisted ──────────────────

  @callable()
  async enqueueAndGetRetryOptions(
    retryOpts: RetryOptions
  ): Promise<RetryOptions | undefined> {
    const id = await this.queue("testQueueNoop", "test", {
      retry: retryOpts
    });
    const item = this.getQueue(id);
    return item?.retry;
  }

  testQueueNoop() {
    // no-op
  }

  @callable()
  async scheduleAndGetRetryOptions(
    retryOpts: RetryOptions
  ): Promise<RetryOptions | undefined> {
    const schedule = await this.schedule(3600, "testScheduleNoop", "test", {
      retry: retryOpts
    });
    const fetched = this.getSchedule(schedule.id);
    return fetched?.retry;
  }

  testScheduleNoop() {
    // no-op
  }

  // ── getQueues with retry options ──────────────────────────────────

  @callable()
  enqueueMultipleAndGetRetryOptions(): (RetryOptions | undefined)[] {
    // Use synchronous queue calls (no await) so items are inserted into
    // SQLite before the background _flushQueue can dequeue any of them.
    // Each queue() call is async but the SQL INSERT is synchronous —
    // awaiting would yield to the microtask queue and let the background
    // flush consume items before we can read them.
    void this.queue(
      "testQueueNoop",
      { group: "a" },
      {
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
      }
    );
    void this.queue(
      "testQueueNoop",
      { group: "a" },
      {
        retry: { maxAttempts: 7, baseDelayMs: 200, maxDelayMs: 5000 }
      }
    );
    void this.queue("testQueueNoop", { group: "b" });
    const items = this.getQueues("group", "a");
    return items.map((item) => item.retry);
  }

  // ── shouldRetry with attempt number ─────────────────────────────

  @callable()
  async retryWithAttemptAwareShouldRetry(): Promise<{
    result: string;
    receivedAttempts: number[];
  }> {
    const receivedAttempts: number[] = [];
    const result = await this.retry(
      async (attempt) => {
        if (attempt <= 3) {
          throw new Error(`fail-${attempt}`);
        }
        return `ok-${attempt}`;
      },
      {
        maxAttempts: 10,
        baseDelayMs: 1,
        maxDelayMs: 10,
        shouldRetry: (_err, nextAttempt) => {
          receivedAttempts.push(nextAttempt);
          return true;
        }
      }
    );
    return { result, receivedAttempts };
  }

  // ── validation ───────────────────────────────────────────────────

  @callable()
  async enqueueWithInvalidRetry(): Promise<{ error: string }> {
    try {
      await this.queue("testQueueNoop", "test", {
        retry: { maxAttempts: 0 }
      });
      return { error: "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async scheduleWithInvalidRetry(): Promise<{ error: string }> {
    try {
      await this.schedule(60, "testScheduleNoop", "test", {
        retry: { maxAttempts: -1 }
      });
      return { error: "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async enqueueWithCrossFieldInvalidRetry(): Promise<{ error: string }> {
    try {
      // baseDelayMs: 5000 exceeds default maxDelayMs: 3000
      await this.queue("testQueueNoop", "test", {
        retry: { baseDelayMs: 5000 }
      });
      return { error: "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async retryWithFractionalAttempts(): Promise<{ error: string }> {
    try {
      await this.retry(async () => "ok", {
        maxAttempts: 2.7,
        baseDelayMs: 1,
        maxDelayMs: 10
      });
      return { error: "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}

/**
 * Test agent with custom class-level retry defaults via static options.
 */
export class TestRetryDefaultsAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  static options = {
    retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 50 }
  };

  @callable()
  async retryUsingDefaults(): Promise<{
    result: string;
    attempts: number[];
  }> {
    const attempts: number[] = [];
    const result = await this.retry(async (attempt) => {
      attempts.push(attempt);
      if (attempt < 5) {
        throw new Error(`fail-${attempt}`);
      }
      return `ok-${attempt}`;
    });
    return { result, attempts };
  }

  @callable()
  async retryExceedingDefaults(): Promise<{ error: string }> {
    try {
      // With class-level maxAttempts=5, always throwing should exhaust after 5
      await this.retry(async (attempt) => {
        throw new Error(`always-fail-${attempt}`);
      });
      return { error: "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @callable()
  async retryWithOverride(): Promise<{
    result: string;
    attempts: number[];
  }> {
    const attempts: number[] = [];
    // Override class-level to only 2 attempts
    const result = await this.retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 2) {
          throw new Error(`fail-${attempt}`);
        }
        return `ok-${attempt}`;
      },
      { maxAttempts: 2 }
    );
    return { result, attempts };
  }
}
