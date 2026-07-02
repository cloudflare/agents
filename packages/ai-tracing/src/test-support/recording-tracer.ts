import { AsyncLocalStorage } from "node:async_hooks";
import { createTracer } from "../tracing/tracer.js";
import type {
  AttributeValue,
  SpanWriter,
  Tracer,
} from "../tracing/tracer.js";

export class RecordingTracer implements Tracer {
  readonly spans: RecordingSpan[] = [];
  readonly rootSpans: RecordingSpan[] = [];
  readonly isTraced: boolean;

  readonly #activeSpan = new AsyncLocalStorage<RecordingSpan | undefined>();
  readonly #tracer: Tracer;

  constructor(options: { readonly isTraced?: boolean } = {}) {
    this.isTraced = options.isTraced ?? true;
    this.#tracer = createTracer({
      startActiveSpan: (name, run) => this.recordSpan(name, run),
    });
  }

  withSpan: Tracer["withSpan"] = (name, attributes, run) => {
    return this.#tracer.withSpan(name, attributes, run);
  };

  startSpan: Tracer["startSpan"] = (name, attributes, activate) => {
    return this.#tracer.startSpan(name, attributes, activate);
  };

  recordSpan<T>(
    name: string,
    callback: (span: RecordingSpan) => T,
    parent: RecordingSpan | undefined = this.#activeSpan.getStore(),
  ): T {
    const span = new RecordingSpan({
      isTraced: this.isTraced,
      name,
      parent,
    });

    this.spans.push(span);
    if (parent) {
      parent.children.push(span);
    } else {
      this.rootSpans.push(span);
    }

    return this.#activeSpan.run(span, () => callback(span));
  }
}

export class RecordingSpan implements SpanWriter {
  readonly name: string;
  readonly parent: RecordingSpan | undefined;
  readonly attributes: Record<string, AttributeValue> = {};
  readonly children: RecordingSpan[] = [];

  #ended = false;
  #endCount = 0;
  #isTraced: boolean;

  constructor(input: {
    readonly isTraced: boolean;
    readonly name: string;
    readonly parent: RecordingSpan | undefined;
  }) {
    this.#isTraced = input.isTraced;
    this.name = input.name;
    this.parent = input.parent;
  }

  get isTraced(): boolean {
    return this.#isTraced && !this.#ended;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get endCount(): number {
    return this.#endCount;
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (!this.isTraced || value === undefined) {
      return;
    }

    this.attributes[key] = value;
  }

  end(): void {
    this.#endCount += 1;
    if (this.#ended) {
      return;
    }

    this.#ended = true;
  }
}
