type MaybePromise<T> = T | Promise<T>;

/** Context supplied when durable components start. */
export type DurableObjectStartContext<Props extends object = object> = {
  /** Properties supplied while resolving the Durable Object. */
  readonly props: Props | undefined;
};

/** Context supplied when durable components inspect an HTTP request. */
export type DurableObjectRequestContext = {
  /** The request entering the Durable Object. */
  readonly request: Request;
};

/**
 * A capability installed into a Durable Object lifecycle.
 *
 * Dependencies such as storage, bindings, clocks, and protocol adapters should
 * be supplied explicitly when constructing the component. Hook contexts carry
 * only data specific to the current lifecycle phase.
 */
export interface DurableObjectLifecycleComponent<
  Props extends object = object
> {
  /** Initialize or recover the component before the host handles work. */
  onStart?(context: DurableObjectStartContext<Props>): MaybePromise<void>;

  /**
   * Inspect an HTTP request before the host's request handler.
   *
   * Return a response to handle the request, or `undefined` to continue.
   */
  onRequest?(
    context: DurableObjectRequestContext
  ): MaybePromise<Response | undefined | void>;

  /** Run work assigned to the component when the host's alarm fires. */
  onAlarm?(): MaybePromise<void>;

  /**
   * Release resources during explicit host disposal.
   *
   * Workers do not invoke this hook on ordinary Durable Object eviction.
   */
  onDispose?(): MaybePromise<void>;
}

/**
 * Runs ordered lifecycle phases for components installed in a Durable Object.
 *
 * Components are resolved lazily on the first phase and retained for the
 * lifetime of this runner. Startup and alarms run in declaration order,
 * requests stop at the first response, and disposal runs in reverse order.
 */
export class DurableObjectLifecycle<Props extends object = object> {
  readonly #resolveComponents: () => Iterable<
    DurableObjectLifecycleComponent<Props>
  >;

  #components:
    | ReadonlyArray<DurableObjectLifecycleComponent<Props>>
    | undefined;
  #startPromise: Promise<void> | undefined;
  #started = false;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;

  /**
   * Create a lifecycle whose components are resolved immediately before the
   * first phase.
   *
   * @param resolveComponents - Returns components in their startup order.
   */
  constructor(
    resolveComponents: () => Iterable<DurableObjectLifecycleComponent<Props>>
  ) {
    this.#resolveComponents = resolveComponents;
  }

  /**
   * Start every component sequentially.
   *
   * Concurrent callers share one startup attempt. A failed attempt is not
   * cached, allowing the host to retry its complete startup phase.
   *
   * @param context - Properties supplied while resolving the Durable Object.
   */
  async start(context: DurableObjectStartContext<Props>): Promise<void> {
    if (this.#disposed) {
      throw new Error("Cannot start a disposed Durable Object lifecycle");
    }
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
   * Offer a request to each component in declaration order.
   *
   * @param context - The request entering the Durable Object.
   * @returns The first component response, or `undefined` when unhandled.
   */
  async request(
    context: DurableObjectRequestContext
  ): Promise<Response | undefined> {
    await this.#ensureReady("handle a request");
    for (const component of this.#getComponents()) {
      const response = await component.onRequest?.(context);
      if (response !== undefined) return response;
    }
    return undefined;
  }

  /** Run every component's alarm hook in declaration order. */
  async alarm(): Promise<void> {
    await this.#ensureReady("handle an alarm");
    for (const component of this.#getComponents()) {
      await component.onAlarm?.();
    }
  }

  /**
   * Dispose every component in reverse order.
   *
   * Disposal is idempotent and best-effort. All hooks run even when one fails;
   * one failure is rethrown directly and multiple failures are reported as an
   * `AggregateError`.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;

    this.#disposed = true;
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  async #runStart(context: DurableObjectStartContext<Props>): Promise<void> {
    for (const component of this.#getComponents()) {
      await component.onStart?.(context);
    }
    this.#started = true;
  }

  async #ensureReady(operation: string): Promise<void> {
    if (this.#disposed) {
      throw new Error(
        `Cannot ${operation} with a disposed Durable Object lifecycle`
      );
    }

    const pending = this.#startPromise;
    if (pending) await pending;

    if (this.#disposed) {
      throw new Error(
        `Cannot ${operation} with a disposed Durable Object lifecycle`
      );
    }
    if (!this.#started) {
      throw new Error(
        `Cannot ${operation} before the Durable Object lifecycle has started`
      );
    }
  }

  async #dispose(): Promise<void> {
    try {
      await this.#startPromise;
    } catch {
      // Startup already surfaced its own failure. Components that started
      // before it failed still receive best-effort disposal below.
    }

    const errors: unknown[] = [];
    const components = this.#getComponents();
    for (let index = components.length - 1; index >= 0; index--) {
      const component = components[index];
      if (!component) continue;
      try {
        await component.onDispose?.();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Durable Object component disposal failed"
      );
    }
  }

  #getComponents(): ReadonlyArray<DurableObjectLifecycleComponent<Props>> {
    if (!this.#components) {
      this.#components = Object.freeze([...this.#resolveComponents()]);
    }
    return this.#components;
  }
}
