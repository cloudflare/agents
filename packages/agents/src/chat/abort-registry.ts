/**
 * AbortRegistry — manages per-request AbortControllers.
 *
 * Shared between AIChatAgent and Think for chat turn cancellation.
 * Each request gets its own AbortController keyed by request ID.
 * Controllers are created lazily on first signal access.
 */

export class AbortRegistry {
  private controllers = new Map<string, AbortController>();

  /**
   * Get or create an AbortController for the given ID and return its signal.
   * Creates the controller lazily on first access.
   */
  getSignal(id: string): AbortSignal | undefined {
    if (typeof id !== "string") {
      return undefined;
    }

    if (!this.controllers.has(id)) {
      this.controllers.set(id, new AbortController());
    }

    return this.controllers.get(id)!.signal;
  }

  /**
   * Get the signal for an existing controller without creating one.
   * Returns undefined if no controller exists for this ID.
   */
  getExistingSignal(id: string): AbortSignal | undefined {
    return this.controllers.get(id)?.signal;
  }

  /** Cancel a specific request by aborting its controller. */
  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }

  /** Remove a controller after the request completes. */
  remove(id: string): void {
    this.controllers.delete(id);
  }

  /** Abort all pending requests and clear the registry. */
  destroyAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }

  /** Check if a controller exists for the given ID. */
  has(id: string): boolean {
    return this.controllers.has(id);
  }

  /** Number of tracked controllers. */
  get size(): number {
    return this.controllers.size;
  }
}
