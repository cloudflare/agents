/**
 * What a framework definition's handler may return instead of a value, to
 * end its attempt another way. Returned, never thrown.
 *
 * @internal Sibling-package support, not a public API.
 */
export class TaskSettlement {
  private constructor(
    readonly kind: "aborted" | "skipped" | "failed" | "park",
    readonly reason: string | undefined,
    readonly error: unknown
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
   * lane held by it, until `Tasks.release()` gives its next attempt a value.
   */
  static park(reason?: string): TaskSettlement {
    return new TaskSettlement("park", reason, undefined);
  }
}
