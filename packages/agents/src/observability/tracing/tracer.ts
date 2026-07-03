/** Attribute values accepted by custom spans. */
export type TraceAttributeValue = string | number | boolean | undefined;

/** Initial or finish attributes attached to a span. */
export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>;

/** A value that may complete synchronously or through a promise-like result. */
export type MaybePromise<T> = T | PromiseLike<T>;

/** Minimal runtime span surface used by tracers. */
export type SpanWriter = {
  readonly isTraced: boolean;
  setAttribute(key: string, value: TraceAttributeValue): void;
  end(): void;
};

/** Runtime capability for starting an active span in the current async context. */
export type SpanRuntime = {
  startActiveSpan<T>(name: string, run: (span: SpanWriter) => T): T;
};

/** AgentTracer seam used by integrations. */
export type AgentTracer = {
  /**
   * Runs `run` inside an active span whose lifetime the tracer owns: the span
   * finishes when `run` returns (or its promise resolves) and fails when `run`
   * throws or rejects. Callers do not call {@link AgentSpan.finish}/{@link AgentSpan.fail};
   * doing so early is safe but the tracer guarantees closure.
   *
   * @template T The value produced by the instrumented work.
   */
  withSpan<T>(
    name: string,
    attributes: TraceAttributes,
    run: (span: AgentSpan) => MaybePromise<T>
  ): MaybePromise<T>;
  /**
   * Activates a span and returns whatever `activate` returns (typically the
   * {@link AgentSpan} handle itself). The caller owns the span lifetime and MUST call
   * {@link AgentSpan.finish} or {@link AgentSpan.fail}; an unfinished span leaks. Use this
   * for work that outlives the callback, such as streams and event-driven
   * telemetry. A throw from `activate` still fails the span before rethrowing.
   *
   * @template T The value returned to the caller, usually the span handle.
   */
  openSpan<T>(
    name: string,
    attributes: TraceAttributes,
    activate: (span: AgentSpan) => T
  ): T;
};

/** Active span handle passed to instrumented work. */
export type AgentSpan = {
  /**
   * Whether this invocation is actually being traced. Instrumentation can use
   * this to skip expensive capture work when nobody is listening.
   */
  readonly isTraced: boolean;
  /** Records the optional finish attributes and ends the span. Idempotent. */
  finish(attributes?: TraceAttributes): void;
  /**
   * Ends the span as not-successful. Genuine failures record `error`/`error.type`;
   * recognized cancellations (an `AbortError`) record `canceled` instead so aborts
   * are not counted as errors. The cause message is never recorded. Idempotent.
   */
  fail(cause: unknown): void;
};

/** Creates a tracer from a runtime span capability. */
export function createTracer(runtime: SpanRuntime): AgentTracer {
  return new RuntimeTracer(runtime);
}

class RuntimeTracer implements AgentTracer {
  constructor(private readonly runtime: SpanRuntime) {}

  withSpan<T>(
    name: string,
    attributes: TraceAttributes,
    run: (span: AgentSpan) => MaybePromise<T>
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

  openSpan<T>(
    name: string,
    attributes: TraceAttributes,
    activate: (span: AgentSpan) => T
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
    attributes: TraceAttributes,
    body: (span: ManagedSpan) => T
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

class ManagedSpan implements AgentSpan {
  #closed = false;

  constructor(private readonly span: SpanWriter) {}

  get isTraced(): boolean {
    return this.span.isTraced;
  }

  /** INTERNAL: see {@link writeSpanAttributes}. */
  writeAttributes(attributes: TraceAttributes): void {
    if (this.#closed) {
      return;
    }

    setAttributes(this.span, attributes);
  }

  finish(attributes: TraceAttributes = {}): void {
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
      // Cancellation is a control path, not a failure: OTel semconv leaves
      // status Unset and records no error.type for cancellations, so aborted
      // operations do not inflate error rates. The vendor marker is additive.
      setAttributes(this.span, { "cloudflare.agents.canceled": true });
    } else {
      // The native span API has no status codes; `otel.status_code` is the
      // spec-defined attribute encoding for status-less backends, so a future
      // OTel-native tracer maps it 1:1 to setStatus({ code: ERROR }).
      setAttributes(this.span, {
        "otel.status_code": "ERROR",
        "error.type":
          cause instanceof Error ? cause.name || "Error" : typeof cause
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

/**
 * INTERNAL: writes attributes onto an open managed span. Lets instrumentation
 * defer expensive attribute computation until after the isTraced check (span
 * names must exist at open time; attributes need not). Not part of the public
 * barrel surface.
 */
export function writeSpanAttributes(
  span: AgentSpan,
  attributes: TraceAttributes
): void {
  if (span instanceof ManagedSpan) {
    span.writeAttributes(attributes);
  }
}

function setAttributes(span: SpanWriter, attributes: TraceAttributes): void {
  if (!span.isTraced) {
    return;
  }

  // Fail-safe: a throwing writer must not leak the span or replace the
  // application's original error with a telemetry one.
  try {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        span.setAttribute(key, value);
      }
    }
  } catch {
    // Drop the attributes; the span still closes.
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
