import { AsyncLocalStorage } from "node:async_hooks";
import { INVALID_SPAN_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import type {
  AttributeValue,
  Attributes,
  Span,
  SpanKind,
  SpanOptions,
  SpanStatus,
  Tracer
} from "@opentelemetry/api";
import { createTracer } from "../../observability/tracing/tracer";
import type {
  TraceAttributeValue,
  AgentTracer
} from "../../observability/tracing/tracer";

/**
 * An AgentTracer over a recording OpenTelemetry tracer, so tests can inspect
 * the spans, attributes, kinds, and statuses the Agents SDK emits.
 */
export class RecordingTracer implements AgentTracer {
  readonly spans: RecordingSpan[] = [];
  readonly rootSpans: RecordingSpan[] = [];
  readonly isTraced: boolean;

  readonly #activeSpan = new AsyncLocalStorage<RecordingSpan | undefined>();
  readonly #tracer: AgentTracer;

  constructor(options: { readonly isTraced?: boolean } = {}) {
    this.isTraced = options.isTraced ?? true;
    const recorder = this;
    const tracer: Tracer = {
      startSpan() {
        throw new Error("The Agents SDK only opens active spans");
      },
      startActiveSpan<F extends (span: Span) => unknown>(
        name: string,
        ...rest: unknown[]
      ): ReturnType<F> {
        const fn = rest.at(-1) as F;
        const spanOptions = (rest.length > 1 ? rest[0] : {}) as SpanOptions;
        return recorder.recordSpan(name, spanOptions, fn) as ReturnType<F>;
      }
    };
    this.#tracer = createTracer(tracer);
  }

  withSpan: AgentTracer["withSpan"] = (name, attributes, run, options) => {
    return this.#tracer.withSpan(name, attributes, run, options);
  };

  openSpan: AgentTracer["openSpan"] = (name, attributes, activate, options) => {
    return this.#tracer.openSpan(name, attributes, activate, options);
  };

  recordSpan<T>(
    name: string,
    options: SpanOptions,
    callback: (span: RecordingSpan) => T,
    parent: RecordingSpan | undefined = this.#activeSpan.getStore()
  ): T {
    const span = new RecordingSpan({
      isTraced: this.isTraced,
      kind: options.kind,
      name,
      parent
    });
    span.setAttributes(options.attributes ?? {});

    this.spans.push(span);
    if (parent) {
      parent.children.push(span);
    } else {
      this.rootSpans.push(span);
    }

    return this.#activeSpan.run(span, () => callback(span));
  }
}

export function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class RecordingSpan implements Span {
  readonly name: string;
  readonly kind: SpanKind | undefined;
  readonly parent: RecordingSpan | undefined;
  readonly attributes: Record<string, TraceAttributeValue> = {};
  readonly children: RecordingSpan[] = [];
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  readonly exceptions: unknown[] = [];

  #ended = false;
  #endCount = 0;
  #isTraced: boolean;

  constructor(input: {
    readonly isTraced: boolean;
    readonly kind: SpanKind | undefined;
    readonly name: string;
    readonly parent: RecordingSpan | undefined;
  }) {
    this.#isTraced = input.isTraced;
    this.kind = input.kind;
    this.name = input.name;
    this.parent = input.parent;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get endCount(): number {
    return this.#endCount;
  }

  spanContext() {
    return INVALID_SPAN_CONTEXT;
  }

  isRecording(): boolean {
    return this.#isTraced && !this.#ended;
  }

  setAttribute(key: string, value: AttributeValue | undefined): this {
    if (!this.isRecording() || value === undefined) {
      return this;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      this.attributes[key] = value;
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
    if (this.isRecording()) {
      this.status = status;
    }
    return this;
  }

  updateName(): this {
    return this;
  }

  recordException(exception: unknown): void {
    this.exceptions.push(exception);
  }

  addEvent(): this {
    return this;
  }

  addLink(): this {
    return this;
  }

  addLinks(): this {
    return this;
  }

  end(): void {
    this.#endCount += 1;
    if (this.#ended) {
      return;
    }

    this.#ended = true;
  }
}
