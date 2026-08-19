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
}

/**
 * Runs ordered lifecycle phases for components installed in a Durable Object.
 *
 * Components are resolved lazily on the first phase and retained for the
 * lifetime of this runner. Startup and alarms run in declaration order, and
 * requests stop at the first response.
 */
export class LifecycleComponentRunner<Props extends object = object> {
  readonly #resolveComponents: () => Iterable<
    DurableObjectLifecycleComponent<Props>
  >;

  #components:
    | ReadonlyArray<DurableObjectLifecycleComponent<Props>>
    | undefined;
  #startPromise: Promise<void> | undefined;
  #started = false;

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

  async #runStart(context: DurableObjectStartContext<Props>): Promise<void> {
    for (const component of this.#getComponents()) {
      await component.onStart?.(context);
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

  #getComponents(): ReadonlyArray<DurableObjectLifecycleComponent<Props>> {
    if (!this.#components) {
      this.#components = Object.freeze([...this.#resolveComponents()]);
    }
    return this.#components;
  }
}
