/**
 * AbortRegistry — manages per-request AbortControllers.
 *
 * Shared between AIChatAgent and Think for chat turn cancellation.
 * Each request gets its own AbortController keyed by request ID.
 * Controllers are created lazily on first signal access.
 */

const NOOP = () => {};

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

  /**
   * Cancel a specific request by aborting its controller. Optionally
   * propagate a reason — surfaces as `signal.reason` on the registry's
   * controller and through any `AbortError` it produces downstream.
   */
  cancel(id: string, reason?: unknown): void {
    this.controllers.get(id)?.abort(reason);
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

  /**
   * Link an external `AbortSignal` to the controller for `id`. When the
   * external signal aborts, the registry's controller is cancelled —
   * propagating the abort reason — exactly the same way an internal
   * cancel would (e.g. via a `chat-request-cancel` WebSocket message).
   *
   * This is the integration point for callers that drive a chat turn
   * programmatically and want to cancel it from outside without knowing
   * the internally-generated request id (e.g. the helper-as-sub-agent
   * pattern, where a parent's `AbortSignal` from the AI SDK tool
   * `execute` needs to land inside a `Think.saveMessages` call running
   * on a child DO).
   *
   * Behavior:
   *
   * - Passing `undefined` is a no-op and returns a no-op detacher, so
   *   callers can unconditionally call this with `options?.signal`.
   * - If the external signal is already aborted, the registry's
   *   controller is created (if needed) and cancelled synchronously.
   * - Otherwise a one-shot `abort` listener is attached. The returned
   *   function detaches it.
   *
   * **Always call the returned detacher in a `finally` block** — the
   * external signal may outlive the request (a parent chat turn that
   * drives many helper turns reuses one signal across all of them) and
   * leaving listeners attached pins closures and grows the listener
   * list on each turn.
   *
   * @returns A detacher function. Call it after the request finishes
   *   (success or failure) to remove the abort listener from `signal`.
   */
  linkExternal(id: string, signal: AbortSignal | undefined): () => void {
    if (!signal) return NOOP;

    if (signal.aborted) {
      // Ensure the registry controller for `id` exists, then cancel it.
      // Calling getSignal first means an early external abort still
      // produces a controller for downstream observers (`getExistingSignal`)
      // rather than a silently-empty registry.
      this.getSignal(id);
      this.cancel(id, signal.reason);
      return NOOP;
    }

    const listener = () => this.cancel(id, signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    return () => signal.removeEventListener("abort", listener);
  }
}
