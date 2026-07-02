/** Attribute values accepted by custom spans. */
export type AttributeValue = string | number | boolean | undefined;

/** Initial or finish attributes attached to a span. */
export type Attributes = Readonly<Record<string, AttributeValue>>;

/** A value that may complete synchronously or through a promise-like result. */
export type MaybePromise<T> = T | PromiseLike<T>;

/** Minimal runtime span surface used by tracers. */
export type SpanWriter = {
  readonly isTraced: boolean;
  setAttribute(key: string, value: AttributeValue): void;
  end(): void;
};

/** Runtime capability for starting an active span in the current async context. */
export type SpanRuntime = {
  startActiveSpan<T>(name: string, run: (span: SpanWriter) => T): T;
};

/** Tracer seam used by integrations. */
export type Tracer = {
  /**
   * Runs `run` inside an active span whose lifetime the tracer owns: the span
   * finishes when `run` returns (or its promise resolves) and fails when `run`
   * throws or rejects. Callers do not call {@link Span.finish}/{@link Span.fail};
   * doing so early is safe but the tracer guarantees closure.
   *
   * @template T The value produced by the instrumented work.
   */
  withSpan<T>(
    name: string,
    attributes: Attributes,
    run: (span: Span) => MaybePromise<T>,
  ): MaybePromise<T>;
  /**
   * Activates a span and returns whatever `activate` returns (typically the
   * {@link Span} handle itself). The caller owns the span lifetime and MUST call
   * {@link Span.finish} or {@link Span.fail}; an unfinished span leaks. Use this
   * for work that outlives the callback, such as streams and event-driven
   * telemetry. A throw from `activate` still fails the span before rethrowing.
   *
   * @template T The value returned to the caller, usually the span handle.
   */
  startSpan<T>(
    name: string,
    attributes: Attributes,
    activate: (span: Span) => T,
  ): T;
};

/** Active span handle passed to instrumented work. */
export type Span = {
  /** Records the optional finish attributes and ends the span. Idempotent. */
  finish(attributes?: Attributes): void;
  /**
   * Ends the span as not-successful. Genuine failures record `error`/`error.type`;
   * recognized cancellations (an `AbortError`) record `canceled` instead so aborts
   * are not counted as errors. The cause message is never recorded. Idempotent.
   */
  fail(cause: unknown): void;
};

/** Creates a tracer from a runtime span capability. */
export function createTracer(runtime: SpanRuntime): Tracer {
  return new RuntimeTracer(runtime);
}

class RuntimeTracer implements Tracer {
  constructor(private readonly runtime: SpanRuntime) {}

  withSpan<T>(
    name: string,
    attributes: Attributes,
    run: (span: Span) => MaybePromise<T>,
  ): MaybePromise<T> {
    return this.activate(name, attributes, (span) => {
      const result = run(span);
      if (isPromiseLike(result)) {
        return Promise.resolve(result)
          .catch((cause: unknown) => {
            span.fail(cause);
            throw cause;
          })
          .finally(() => {
            span.close();
          });
      }

      span.close();
      return result;
    });
  }

  startSpan<T>(
    name: string,
    attributes: Attributes,
    activate: (span: Span) => T,
  ): T {
    return this.activate(name, attributes, activate);
  }

  /**
   * Shared scaffold: opens an active span, seeds its attributes, and fails the
   * span on a thrown defect before rethrowing. The `body` decides the span's
   * finishing policy (managed vs. caller-owned).
   */
  private activate<T>(
    name: string,
    attributes: Attributes,
    body: (span: ManagedSpan) => T,
  ): T {
    return this.runtime.startActiveSpan(name, (writer) => {
      setAttributes(writer, attributes);
      const span = new ManagedSpan(writer);

      try {
        return body(span);
      } catch (cause: unknown) {
        span.fail(cause);
        throw cause;
      }
    });
  }
}

class ManagedSpan implements Span {
  #closed = false;

  constructor(private readonly span: SpanWriter) {}

  finish(attributes: Attributes = {}): void {
    if (this.#closed) {
      return;
    }

    setAttributes(this.span, attributes);
    this.close();
  }

  fail(cause: unknown): void {
    if (this.#closed) {
      return;
    }

    if (isCancellation(cause)) {
      // Cancellation is a control path, not a failure: record it distinctly so
      // aborted operations do not inflate error rates. The Cloudflare span API
      // exposes no status code, so this classification rides on an attribute.
      setAttributes(this.span, { "canceled": true });
    } else {
      setAttributes(this.span, {
        "error": true,
        "error.type": cause instanceof Error ? (cause.name || "Error") : typeof cause,
      });
    }

    this.close();
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.span.end();
  }
}

function setAttributes(span: SpanWriter, attributes: Attributes): void {
  if (!span.isTraced) {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}

function isPromiseLike<T>(value: MaybePromise<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * Recognizes caller/runtime cancellation (an `AbortError`, e.g. from an aborted
 * `AbortSignal`) so it can be classified separately from genuine failures. A
 * `DOMException` named `AbortError` is not always an `Error` instance, so this
 * probes the `name` field structurally rather than via `instanceof`.
 */
function isCancellation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "AbortError"
  );
}
