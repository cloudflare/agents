/**
 * What a framework definition's handler may return instead of a value, to
 * end its attempt another way. Returned, never thrown.
 *
 * @internal Sibling-package support, not a public API.
 */
export class TaskSettlement {
  private constructor(
    readonly kind: "aborted" | "skipped" | "failed" | "park" | "retry",
    readonly reason: string | undefined,
    readonly error: unknown,
    readonly wakeAt?: number
  ) {}

  /** End the run `aborted`. */
  static aborted(reason?: string): TaskSettlement {
    return new TaskSettlement("aborted", reason, undefined);
  }

  /** End the run `skipped`. */
  static skipped(reason?: string): TaskSettlement {
    return new TaskSettlement("skipped", reason, undefined);
  }

  /** End the run `error` with `error`, without a retry. */
  static failed(error: unknown): TaskSettlement {
    return new TaskSettlement("failed", undefined, error);
  }

  /**
   * Leave the run `pending` with wait reason `park` and no deadline, its
   * lane held by it, until `Tasks.settle()` ends it.
   */
  static park(reason?: string): TaskSettlement {
    return new TaskSettlement("park", reason, undefined);
  }

  /**
   * Leave the run `pending` with wait reason `retry` until `at` (epoch ms;
   * a past `at` is due now); its next attempt runs then, as `attempt + 1`,
   * and counts against the definition's `maxAttempts` if it sets one. No
   * journal row and no error status between attempts: the handler owns the
   * backoff and the give-up, which a thrown error would hand to Tasks.
   */
  static retry(at: number): TaskSettlement {
    if (!Number.isFinite(at)) {
      throw new TypeError(
        `TaskSettlement.retry: \`at\` must be finite, got ${at}`
      );
    }
    return new TaskSettlement("retry", undefined, undefined, at);
  }
}
