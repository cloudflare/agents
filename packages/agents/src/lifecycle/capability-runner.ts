type MaybePromise<T> = T | Promise<T>;

/** Context supplied when durable capabilities start. */
export type CapabilityStartContext<Props extends object = object> = {
  /** Properties supplied while resolving the Durable Object. */
  readonly props: Props | undefined;
};

/** Context supplied when durable capabilities inspect an HTTP request. */
export type CapabilityRequestContext = {
  /** The request entering the Durable Object. */
  readonly request: Request;
};

/**
 * A capability installed into a Durable Object lifecycle.
 *
 * Dependencies such as storage, bindings, clocks, and protocol adapters should
 * be supplied explicitly when constructing the capability. Hooks run in the
 * current Lifecycle Agent context, while hook parameters carry data specific
 * to the current phase.
 */
export interface DurableObjectCapability<Props extends object = object> {
  /** Initialize or recover the capability before the host handles work. */
  onStart?(context: CapabilityStartContext<Props>): MaybePromise<void>;

  /**
   * Inspect an HTTP request before the host's request handler.
   *
   * Return a response to handle the request, or `undefined` to continue.
   */
  onRequest?(
    context: CapabilityRequestContext
  ): MaybePromise<Response | undefined | void>;

  /** Run work assigned to the capability when the host's alarm fires. */
  onAlarm?(): MaybePromise<void>;
}

/**
 * Runs ordered lifecycle phases for capabilities installed in a Durable Object.
 *
 * Capabilities are resolved lazily on the first phase and retained for the
 * lifetime of this runner. Startup and alarms run in declaration order, and
 * requests stop at the first response.
 */
export class CapabilityRunner<Props extends object = object> {
  readonly #resolveCapabilities: () => Iterable<DurableObjectCapability<Props>>;

  #capabilities: ReadonlyArray<DurableObjectCapability<Props>> | undefined;
  #startPromise: Promise<void> | undefined;
  #started = false;

  /**
   * Create a lifecycle whose capabilities are resolved immediately before the
   * first phase.
   *
   * @param resolveCapabilities - Returns capabilities in their startup order.
   */
  constructor(
    resolveCapabilities: () => Iterable<DurableObjectCapability<Props>>
  ) {
    this.#resolveCapabilities = resolveCapabilities;
  }

  /**
   * Start every capability sequentially.
   *
   * Concurrent callers share one startup attempt. A failed attempt is not
   * cached, allowing the host to retry its complete startup phase.
   *
   * @param context - Properties supplied while resolving the Durable Object.
   */
  async start(context: CapabilityStartContext<Props>): Promise<void> {
    if (this.#started) return;

    const pending = this.#startPromise;
    if (pending) {
      await pending;
      return;
    }

    const attempt = this.#runStart(context);
    this.#startPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.#startPromise === attempt) {
        this.#startPromise = undefined;
      }
      throw error;
    }
  }

  /**
   * Offer a request to each capability in declaration order.
   *
   * @param context - The request entering the Durable Object.
   * @returns The first capability response, or `undefined` when unhandled.
   */
  async request(
    context: CapabilityRequestContext
  ): Promise<Response | undefined> {
    await this.#ensureReady("handle a request");
    for (const capability of this.#getCapabilities()) {
      const response = await capability.onRequest?.(context);
      if (response !== undefined) return response;
    }
    return undefined;
  }

  /** Run every capability's alarm hook in declaration order. */
  async alarm(): Promise<void> {
    await this.#ensureReady("handle an alarm");
    for (const capability of this.#getCapabilities()) {
      await capability.onAlarm?.();
    }
  }

  async #runStart(context: CapabilityStartContext<Props>): Promise<void> {
    for (const capability of this.#getCapabilities()) {
      await capability.onStart?.(context);
    }
    this.#started = true;
  }

  async #ensureReady(operation: string): Promise<void> {
    const pending = this.#startPromise;
    if (pending) await pending;
    if (!this.#started) {
      throw new Error(
        `Cannot ${operation} before the Durable Object lifecycle has started`
      );
    }
  }

  #getCapabilities(): ReadonlyArray<DurableObjectCapability<Props>> {
    if (!this.#capabilities) {
      this.#capabilities = Object.freeze([...this.#resolveCapabilities()]);
    }
    return this.#capabilities;
  }
}
