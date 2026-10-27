/**
 * An independent model of Workers native tracing (`cloudflare:workers`
 * `tracing`): spans parent to the async-context active span, only
 * `startActiveSpan` activates, and `end()` has no effect on the invocation
 * root. The real runtime is covered by `src/otel-tests`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  NativeException,
  NativeSpan,
  NativeSpanStatus
} from "../../observability/otel/native";

let nextId = 0;

export class FakeSpan implements NativeSpan {
  readonly attributes: Record<string, string | number | boolean> = {};
  readonly exceptions: NativeException[] = [];
  readonly children: FakeSpan[] = [];
  readonly spanId: string;
  readonly traceId: string;
  status: NativeSpanStatus = { code: "unset" };
  ended = false;

  constructor(
    public name: string,
    readonly parent: FakeSpan | undefined,
    readonly root = false,
    readonly traced = true,
    /** Opened outside any request: untraced, all-zero IDs, never exported. */
    readonly detached = false
  ) {
    this.spanId = detached
      ? "0".repeat(16)
      : (++nextId).toString(16).padStart(16, "0");
    this.traceId = parent?.traceId ?? this.spanId.padStart(32, "0");
    parent?.children.push(this);
  }

  get isTraced(): boolean {
    return this.traced && !this.detached && !this.ended;
  }

  spanContext() {
    return { traceId: this.traceId, spanId: this.spanId, traceFlags: 0 };
  }

  setAttribute(key: string, value: string | number | boolean): this {
    if (typeof value === "object") {
      throw new TypeError("Native attributes must be scalar");
    }
    if (this.isTraced) {
      this.attributes[key] = value;
    }
    return this;
  }

  recordException(exception: NativeException): void {
    if (this.isTraced) {
      this.exceptions.push(exception);
    }
  }

  /** The documented runtime rules for `Span.setStatus`. */
  setStatus(status: NativeSpanStatus): this {
    if (!["unset", "ok", "error"].includes(status.code)) {
      throw new TypeError(`Invalid span status code: ${status.code}`);
    }
    if (
      !this.isTraced ||
      this.status.code === "ok" ||
      status.code === "unset"
    ) {
      return this;
    }
    this.status =
      status.code === "error" && status.message !== undefined
        ? { code: "error", message: status.message }
        : { code: status.code };
    return this;
  }

  updateName(name: string): this {
    if (this.isTraced) {
      this.name = name;
    }
    return this;
  }

  end(): void {
    if (!this.root) {
      this.ended = true;
    }
  }
}

export type FakeTracing = {
  readonly recorded: FakeSpan[];
  /** Runs `fn` as one request with its own invocation root span. */
  invocation<T>(fn: (root: FakeSpan) => T, options?: { traced?: boolean }): T;
  /**
   * Runs `fn` like a Durable Object constructor inside `invocation`: the
   * runtime reports no active span, but spans opened here parent to the
   * request's root.
   */
  constructing<T>(fn: () => T): T;
  /** A platform operation (fetch, KV, ...) under the active native span. */
  platform(name: string): FakeSpan;
  /** A native span via `tracing.startActiveSpan`, e.g. from the Agents SDK tracer. */
  startActiveSpan<T>(name: string, callback: (span: FakeSpan) => T): T;
  getActiveSpan(): FakeSpan | undefined;
};

export function createFakeTracing(
  options: { readonly legacy?: boolean } = {}
): FakeTracing {
  const active = new AsyncLocalStorage<FakeSpan>();
  const hidden = new AsyncLocalStorage<boolean>();
  const recorded: FakeSpan[] = [];
  const create = (
    name: string,
    parent: FakeSpan | undefined,
    root = false,
    traced = parent?.traced ?? true
  ) => {
    const detached = parent === undefined && !root;
    const span = new FakeSpan(name, parent, root, traced, detached);
    if (options.legacy) {
      // Shadow the newer methods so the bridge sees an older runtime.
      Object.assign(span, {
        spanContext: undefined,
        setStatus: undefined,
        updateName: undefined
      });
    }
    if (!detached) {
      recorded.push(span);
    }
    return span;
  };

  return {
    recorded,
    getActiveSpan: () => {
      const span = active.getStore();
      return hidden.getStore() === true && span?.root ? undefined : span;
    },
    constructing: (fn) => hidden.run(true, fn),
    startActiveSpan(name, callback) {
      const span = create(name, active.getStore());
      return active.run(span, () => callback(span));
    },
    platform(name) {
      const span = create(name, active.getStore());
      span.end();
      return span;
    },
    invocation(fn, { traced = true } = {}) {
      const root = create("invocation", undefined, true, traced);
      return active.run(root, () => fn(root));
    }
  };
}
