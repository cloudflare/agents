import { AsyncLocalStorage } from "node:async_hooks";

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

/** Optional automatic lifetime policy for invocation-bounded spans. */
export type SpanLifetime = {
  /**
   * Close the span no later than the end of the surrounding
   * {@link withInvocationScope}, so it cannot outlive the native invocation
   * that owns its tracing context. Ignored outside such a scope.
   */
  readonly boundToInvocation?: boolean;
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
    run: (span: AgentSpan) => MaybePromise<T>,
    lifetime?: SpanLifetime
  ): T | Promise<T>;
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
    activate: (span: AgentSpan) => T,
    lifetime?: SpanLifetime
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
   * Ends the span as not-successful. Genuine failures record `error.type`;
   * recognized cancellations (an `AbortError`) record `canceled` instead so aborts
   * are not counted as errors. The cause message is never recorded. Idempotent.
   */
  fail(cause: unknown): void;
};

type InvocationScope = {
  /** Bounded spans still open. Emptied when the invocation ends. */
  readonly open: Set<ManagedSpan>;
  /** Whether the invocation this scope represents has already ended. */
  ended: boolean;
};

export type InvocationScopeOptions = {
  /**
   * Open a scope even inside a live one, for work deliberately detached from
   * the handler that started it — `ctx.waitUntil` bodies, queue drains — which
   * runs on past that handler and must not be cut off with it.
   */
  readonly detached?: boolean;
};

/**
 * Spans that asked to be invocation-bounded while a scope was active. Closed
 * when that scope ends; see {@link withInvocationScope}.
 */
const invocationScope = new AsyncLocalStorage<InvocationScope>();

/**
 * Runs `body` as one traced invocation.
 *
 * Work that escapes its native invocation cannot be traced from the context it
 * started in: the still-open span is force-closed against the invocation that
 * owned that context, which reports a negative duration or `span_not_ended`.
 * Spans opened with {@link SpanLifetime.boundToInvocation} inside this scope
 * are therefore closed before `body` settles — but not one moment earlier, so
 * everything that completes during the invocation (the normal case: a chat
 * turn is awaited by the handler that received it) still records its finish
 * attributes. A span truncated this way is marked
 * `cloudflare.agents.span.truncated` rather than passing as complete.
 */
export function withInvocationScope<T>(
  body: () => T,
  options?: InvocationScopeOptions
): T {
  // Nested scopes would truncate spans at an inner boundary that is not an
  // invocation edge, so the outermost live scope owns the lifetime. A scope
  // that has already ended is not an enclosing invocation at all — it is a
  // leftover context on work that resumed later — so `body` starts a new one.
  const current = invocationScope.getStore();
  if (options?.detached !== true && current !== undefined && !current.ended) {
    return body();
  }

  const scope: InvocationScope = { ended: false, open: new Set() };
  const endInvocation = () => {
    scope.ended = true;
    for (const span of scope.open) {
      // Fail open: this runs on the return path of every agent handler, so a
      // span writer that throws must not take the handler's result with it,
      // nor stop the remaining spans from closing.
      try {
        span.truncate();
      } catch {
        // Nothing useful to do with a broken span writer.
      }
    }
    scope.open.clear();
  };

  return invocationScope.run(scope, () => {
    let result: T;
    try {
      result = body();
    } catch (cause: unknown) {
      endInvocation();
      throw cause;
    }

    if (isPromiseLike(result)) {
      // SAFETY: T is promise-like here, so the settled promise is still a T.
      return Promise.resolve(result).finally(endInvocation) as T;
    }

    endInvocation();
    return result;
  });
}

/** Creates a tracer from a runtime span capability. */
export function createTracer(runtime: SpanRuntime): AgentTracer {
  return new RuntimeTracer(runtime);
}

class RuntimeTracer implements AgentTracer {
  constructor(private readonly runtime: SpanRuntime) {}

  withSpan<T>(
    name: string,
    attributes: TraceAttributes,
    run: (span: AgentSpan) => MaybePromise<T>,
    lifetime?: SpanLifetime
  ): T | Promise<T> {
    return this.activate(name, attributes, (span) => {
      // Ask before running: a span that opens and closes in one tick still
      // needs to know whether that tick happened after its invocation ended.
      const outOfBand =
        lifetime?.boundToInvocation === true && bindToInvocation(span);
      const result = run(span);
      if (isPromiseLike(result)) {
        if (outOfBand) {
          span.truncate();
        }
        return Promise.resolve(result)
          .catch((cause: unknown) => {
            span.fail(cause);
            throw cause;
          })
          .finally(() => {
            span.close();
          });
      }

      if (outOfBand) {
        span.truncate();
      }
      span.close();
      return result;
    });
  }

  openSpan<T>(
    name: string,
    attributes: TraceAttributes,
    activate: (span: AgentSpan) => T,
    lifetime?: SpanLifetime
  ): T {
    if (!lifetime?.boundToInvocation) {
      return this.activate(name, attributes, activate);
    }

    return this.activate(name, attributes, (span) => {
      const invocationEnded = bindToInvocation(span);
      try {
        return activate(span);
      } finally {
        // Truncate only once `activate` has had its turn: callers that open
        // with an empty attribute set and write the real one lazily (the AI
        // operation span does, to stay cheap for untraced calls) would
        // otherwise be closed before writing anything at all.
        if (invocationEnded) {
          span.truncate();
        }
      }
    });
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
      // Workers' custom Span API does not currently expose setStatus(). Do not
      // invent an `otel.status_code` attribute: status is span state in OTel,
      // not an attribute. error.type remains the standard queryable marker.
      setAttributes(this.span, {
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

  /**
   * Closes a span whose work has not finished because its invocation is ending.
   * The marker distinguishes "this span has no tokens because the turn escaped
   * its invocation" from "this span completed and reported none".
   */
  truncate(): void {
    if (this.#closed) {
      return;
    }

    setAttributes(this.span, { "cloudflare.agents.span.truncated": true });
    this.close();
  }
}

/**
 * Registers a span for closure at the end of the current invocation, and
 * reports whether that invocation has already ended.
 *
 * Outside any scope the span keeps its natural lifetime: with no known
 * invocation boundary there is nothing to bound it to, and closing early would
 * discard finish attributes for no gain. Inside a scope that has already
 * ended — work resumed later while still carrying this context — the span
 * cannot outlive an invocation that is already gone, so the caller truncates
 * it as soon as it has written what it knows.
 */
function bindToInvocation(span: ManagedSpan): boolean {
  const scope = invocationScope.getStore();
  if (scope === undefined) {
    return false;
  }

  if (scope.ended) {
    return true;
  }

  scope.open.add(span);
  return false;
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
