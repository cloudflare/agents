/**
 * The OpenTelemetry API on Workers native tracing.
 *
 * Every recording OTel span is a native span. Native tracing has no manual
 * parent wiring: a span's parent is whatever native span is active (in the
 * async context) when it opens, and a span can only be active inside the
 * callback that opened it. The bridge works within that:
 *
 * - Every span opens with `tracing.startActiveSpan`, so it is native-active for
 *   at least a moment. Inside that moment the bridge captures an async-context
 *   snapshot: a way back into "this span is the active native parent".
 * - `startActiveSpan` runs the caller's function inside the native callback.
 * - `startSpan` returns from the native callback at once (the span stays open
 *   and inactive, as OTel requires). When the span later becomes active through
 *   `context.with(trace.setSpan(ctx, span), fn)` — the pattern the MCP SDK and
 *   other instrumentation use — `fn` runs inside the snapshot, so platform
 *   spans (fetch, KV, D1, Durable Objects) and child spans nest under it.
 * - A span is only opened where its native parent is the span the caller asked
 *   for. Anything native tracing cannot represent faithfully (remote parents,
 *   new roots, explicit start times, parents from another request) returns a
 *   non-recording span instead of a span under a substitute parent.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createContextKey,
  diag,
  INVALID_SPAN_CONTEXT,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace
} from "@opentelemetry/api";
import type {
  Attributes,
  Context,
  ContextManager,
  Exception,
  Link,
  Span,
  SpanContext,
  SpanOptions,
  SpanStatus,
  TimeInput,
  Tracer,
  TracerProvider
} from "@opentelemetry/api";
import type { NativeException, NativeSpan, NativeTracing } from "./native";

/**
 * Runs `fn` in a captured async context (`AsyncLocalStorage.snapshot()`),
 * which includes the native active span.
 */
export type ContextSnapshot = <R>(fn: () => R) => R;

export type BridgeRuntime = {
  readonly tracing: NativeTracing;
  /** Captures the current async context. Defaults to `AsyncLocalStorage.snapshot`. */
  readonly snapshot?: () => ContextSnapshot;
};

/** The OTel components one bridge registers. */
export type OpenTelemetryBridge = {
  readonly contextManager: ContextManager;
  readonly tracerProvider: TracerProvider;
};

const reported = new Set<string>();

/**
 * Marks a context taken where no native span was visible. Durable Object
 * constructors and `blockConcurrencyWhile` callbacks report no active span,
 * yet native spans opened there still parent to the request; at module scope
 * they record nothing. Either way the runtime, not the bridge, picks.
 */
const AMBIENT = createContextKey("agents: ambient native span");

/**
 * Reports a dropped or refused feature once per isolate through OTel's `diag`
 * logger. Messages name the feature only, never span names or values.
 */
function unsupported(feature: string): void {
  if (reported.has(feature)) {
    return;
  }
  reported.add(feature);
  diag.warn(
    `agents/observability: ${feature} cannot be represented by Workers tracing.`
  );
}

/** Telemetry must never replace the application's result or error. */
function safely(write: () => void, feature: string): void {
  try {
    write();
  } catch {
    unsupported(`${feature} (the runtime rejected the value)`);
  }
}

type Scope = {
  /** The OTel context set by `context.with`. */
  readonly context: Context;
  /** The native active span when that context was set. */
  readonly native: NativeSpan | undefined;
};

class Bridge implements OpenTelemetryBridge {
  readonly contextManager: WorkersContextManager;
  readonly tracerProvider: TracerProvider;
  /** One OTel wrapper per native span, so identity comparisons hold. */
  readonly #spans = new WeakMap<NativeSpan, WorkersSpan>();
  readonly #tracer: Tracer;
  readonly #snapshot: () => ContextSnapshot;

  constructor(
    readonly native: NativeTracing,
    snapshot: () => ContextSnapshot
  ) {
    this.#snapshot = snapshot;
    this.contextManager = new WorkersContextManager(this).enable();
    this.#tracer = new WorkersTracer(this);
    const tracer = this.#tracer;
    this.tracerProvider = { getTracer: () => tracer };
  }

  /** The OTel span for a native span the bridge did not open (root, agent spans). */
  wrap(native: NativeSpan): WorkersSpan {
    let span = this.#spans.get(native);
    if (span === undefined) {
      span = new WorkersSpan(this, native, undefined);
      this.#spans.set(native, span);
    }
    return span;
  }

  /**
   * Opens a native span where `placement` says, seeds its attributes, and
   * calls `body` while it is the active native span.
   */
  open<T>(
    name: string,
    attributes: Attributes | undefined,
    placement: OpenPlacement,
    body: (span: WorkersSpan) => T
  ): T {
    const start = () =>
      this.native.startActiveSpan(name, (native) => {
        const span = new WorkersSpan(this, native, this.#snapshot());
        this.#spans.set(native, span);
        if (attributes !== undefined) {
          span.setAttributes(attributes);
        }
        return body(span);
      });
    return placement.in === undefined ? start() : placement.in(start);
  }

  /**
   * Decides whether a span can open natively under the requested parent, and
   * from which async context.
   */
  place(options: SpanOptions, parentContext: Context): Placement {
    const parent = options.root ? undefined : trace.getSpan(parentContext);
    const current = this.native.getActiveSpan();
    const refuse = (feature: string): Placement => {
      unsupported(feature);
      const ids = parent?.spanContext();
      return {
        refused:
          ids !== undefined && isSpanContextValid(ids)
            ? ids
            : INVALID_SPAN_CONTEXT
      };
    };

    if (current === undefined) {
      // No visible native span (see AMBIENT): let native tracing choose the
      // parent, unless the caller asked for something specific.
      return parent === undefined &&
        !options.root &&
        options.startTime === undefined &&
        parentContext.getValue(AMBIENT) === true
        ? { in: undefined }
        : refuse("Spans outside a request");
    }
    if (parent === undefined) {
      return refuse("Root spans and spans without a parent");
    }
    if (!(parent instanceof WorkersSpan) || parent.bridge !== this) {
      return refuse("Spans under remote or foreign parents");
    }
    if (options.startTime !== undefined) {
      return refuse("Explicit span start timestamps");
    }
    if (options.links !== undefined && options.links.length > 0) {
      unsupported("Span links (dropped)");
    }
    // Workers spans have no kind. Instrumentation (MCP CLIENT/SERVER spans,
    // HTTP client spans) is still recorded; the kind is not.
    if (parent.native === current) {
      return { in: undefined };
    }
    const reentry = parent.reentry(current);
    return reentry === undefined
      ? refuse("Spans under a parent from another request or scope")
      : { in: reentry };
  }

  /** Runs `fn` with `context` as the OTel context and `native` as its native span. */
  run<T>(context: Context, native: NativeSpan | undefined, fn: () => T): T {
    return this.contextManager.run({ context, native }, fn);
  }
}

type OpenPlacement = {
  /** Where to open: `undefined` for the current context, else a snapshot. */
  readonly in: ContextSnapshot | undefined;
};
type Placement = OpenPlacement | { readonly refused: SpanContext };

class WorkersSpan implements Span {
  readonly #traceId: string | undefined;

  constructor(
    readonly bridge: Bridge,
    readonly native: NativeSpan,
    /** The async context in which `native` is active; only for spans the bridge opened. */
    readonly snapshot: ContextSnapshot | undefined
  ) {
    this.#traceId = snapshot === undefined ? undefined : traceIdOf(native);
  }

  /**
   * The snapshot to re-enter so this span is the active native parent again,
   * or `undefined` when that would cross into another request.
   */
  reentry(current: NativeSpan): ContextSnapshot | undefined {
    if (this.snapshot === undefined) {
      return undefined;
    }
    const currentTraceId = traceIdOf(current);
    if (
      this.#traceId !== undefined &&
      currentTraceId !== undefined &&
      this.#traceId !== currentTraceId
    ) {
      return undefined;
    }
    return this.snapshot;
  }

  spanContext(): SpanContext {
    let ids: SpanContext | undefined;
    safely(() => {
      ids = this.native.spanContext?.();
    }, "Span context");
    if (ids === undefined) {
      return INVALID_SPAN_CONTEXT;
    }
    const { traceId, spanId, traceFlags } = ids;
    return { traceId, spanId, traceFlags };
  }

  isRecording(): boolean {
    return this.native.isTraced;
  }

  setAttribute(key: string, value: unknown): this {
    if (key === "" || value === undefined || !this.native.isTraced) {
      return this;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safely(() => this.native.setAttribute(key, value), "Attribute");
    } else {
      // OTel array attributes are typed values. JSON text under an array-typed
      // key would mislead backends, so drop rather than serialize.
      unsupported("Array and non-scalar attribute values (dropped)");
    }
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) {
      this.setAttribute(key, value);
    }
    return this;
  }

  setStatus(status: SpanStatus): this {
    // The runtime applies OTel's status rules (Ok is final, Unset has no
    // effect, the message is kept only with Error). Unset needs no call.
    if (
      status.code !== SpanStatusCode.OK &&
      status.code !== SpanStatusCode.ERROR
    ) {
      return this;
    }
    const setStatus = this.native.setStatus;
    if (setStatus === undefined) {
      unsupported("Span status on this runtime version");
      return this;
    }
    safely(
      () =>
        setStatus.call(
          this.native,
          status.code === SpanStatusCode.ERROR
            ? status.message === undefined
              ? { code: "error" }
              : { code: "error", message: status.message }
            : { code: "ok" }
        ),
      "Span status"
    );
    return this;
  }

  updateName(name: string): this {
    const updateName = this.native.updateName;
    if (updateName === undefined) {
      unsupported("Span renames on this runtime version");
      return this;
    }
    safely(() => updateName.call(this.native, name), "Span rename");
    return this;
  }

  recordException(exception: Exception, time?: TimeInput): void {
    if (time !== undefined) {
      unsupported("Explicit exception timestamps (recorded at runtime time)");
    }
    safely(
      () => this.native.recordException(exception as NativeException),
      "Exception"
    );
  }

  end(endTime?: TimeInput): void {
    if (endTime !== undefined) {
      unsupported("Explicit end timestamps (ended at runtime time)");
    }
    safely(() => this.native.end(), "Span end");
  }

  addEvent(
    _name: string,
    _attributesOrStartTime?: Attributes | TimeInput,
    _startTime?: TimeInput
  ): this {
    unsupported("Span events other than exceptions (dropped)");
    return this;
  }

  addLink(_link: Link): this {
    unsupported("Span links (dropped)");
    return this;
  }

  addLinks(links: Link[]): this {
    if (links.length > 0) {
      unsupported("Span links (dropped)");
    }
    return this;
  }
}

function traceIdOf(native: NativeSpan): string | undefined {
  try {
    const traceId = native.spanContext?.().traceId;
    return traceId === undefined || /^0+$/.test(traceId) ? undefined : traceId;
  } catch {
    return undefined;
  }
}

class WorkersTracer implements Tracer {
  constructor(private readonly bridge: Bridge) {}

  startSpan(
    name: string,
    options: SpanOptions = {},
    parentContext: Context = this.bridge.contextManager.active()
  ): Span {
    const placement = this.bridge.place(options, parentContext);
    if ("refused" in placement) {
      return trace.wrapSpanContext(placement.refused);
    }
    return this.bridge.open(
      name,
      options.attributes,
      placement,
      (span) => span
    );
  }

  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn: SpanOptions | F,
    contextOrFn?: Context | F,
    maybeFn?: F
  ): ReturnType<F> {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const parentContext =
      typeof contextOrFn === "object"
        ? contextOrFn
        : this.bridge.contextManager.active();
    const fn =
      typeof optionsOrFn === "function"
        ? optionsOrFn
        : typeof contextOrFn === "function"
          ? contextOrFn
          : maybeFn;
    if (fn === undefined) {
      throw new TypeError("startActiveSpan requires a callback");
    }

    const placement = this.bridge.place(options, parentContext);
    if ("refused" in placement) {
      const span = trace.wrapSpanContext(placement.refused);
      return this.bridge.contextManager.with(
        trace.setSpan(parentContext, span),
        () => fn(span)
      ) as ReturnType<F>;
    }
    // The caller owns `end()`, as with any OTel tracer.
    return this.bridge.open(name, options.attributes, placement, (span) =>
      this.bridge.run(trace.setSpan(parentContext, span), span.native, () =>
        fn(span)
      )
    ) as ReturnType<F>;
  }
}

class WorkersContextManager implements ContextManager {
  #storage: AsyncLocalStorage<Scope> | undefined;

  constructor(private readonly bridge: Bridge) {}

  active(): Context {
    const storage = this.#storage;
    if (storage === undefined) {
      return ROOT_CONTEXT;
    }
    const scope = storage.getStore();
    const native = this.bridge.native.getActiveSpan();
    // An explicit OTel context wins until code enters a new native span
    // (an Agents SDK span, `tracing.enterSpan`, ...), which then becomes the
    // active span while the rest of the context (baggage, values) carries on.
    if (scope !== undefined && scope.native === native) {
      return scope.context;
    }
    if (native === undefined) {
      return scope?.context ?? ROOT_CONTEXT.setValue(AMBIENT, true);
    }
    return trace.setSpan(
      scope?.context ?? ROOT_CONTEXT,
      this.bridge.wrap(native)
    );
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const call = () => fn.apply(thisArg, args);
    if (this.#storage === undefined) {
      return call();
    }
    const current = this.bridge.native.getActiveSpan();
    const span = trace.getSpan(context);
    if (
      span instanceof WorkersSpan &&
      span.bridge === this.bridge &&
      current !== undefined &&
      span.native !== current
    ) {
      // Make the span the active native parent again (see the module note).
      const reentry = span.reentry(current);
      if (reentry !== undefined) {
        return reentry(() => this.run({ context, native: span.native }, call));
      }
      unsupported("Activating a span from another request or scope");
    }
    return this.run({ context, native: current }, call);
  }

  /** INTERNAL: runs `fn` in `scope` without native activation. */
  run<T>(scope: Scope, fn: () => T): T {
    const storage = this.#storage;
    return storage === undefined ? fn() : storage.run(scope, fn);
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target !== "function") {
      unsupported("context.bind on non-functions (left unchanged)");
      return target;
    }
    const manager = this;
    const callable = target as (...args: unknown[]) => unknown;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => callable.apply(this, args));
    } as T;
  }

  enable(): this {
    this.#storage ??= new AsyncLocalStorage<Scope>();
    return this;
  }

  /** Workers has no `AsyncLocalStorage.disable()`; drop access to old scopes instead. */
  disable(): this {
    this.#storage = undefined;
    return this;
  }
}

/** Creates (but does not register) the OTel components for native tracing. */
export function createOpenTelemetryBridge(
  runtime: BridgeRuntime
): OpenTelemetryBridge {
  return new Bridge(
    runtime.tracing,
    runtime.snapshot ?? (() => AsyncLocalStorage.snapshot())
  );
}
