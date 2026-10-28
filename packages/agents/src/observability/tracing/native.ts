/**
 * The subset of Workers native tracing (`import { tracing } from
 * "cloudflare:workers"`) that the Agents SDK builds on. Methods added in later
 * runtime releases are optional and feature-detected per call, so an older
 * runtime degrades (no IDs, no status, no rename) instead of throwing.
 */

/** A scalar attribute value accepted by native spans. */
export type NativeAttributeValue = string | number | boolean;

/** Native span identity, matching the IDs Workers Observability exports. */
export type NativeSpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
};

/** Native span status. */
export type NativeSpanStatus = {
  readonly code: "unset" | "ok" | "error";
  readonly message?: string;
};

/** An exception accepted by `Span.recordException`. */
export type NativeException =
  | string
  | {
      readonly code?: string | number;
      readonly name?: string;
      readonly message?: string;
      readonly stack?: string;
    };

/** A native span. */
export type NativeSpan = {
  /**
   * False when observability is disabled, and after `end()`. Does not reflect
   * head sampling: an unsampled request can report `true`.
   */
  readonly isTraced: boolean;
  setAttribute(key: string, value: NativeAttributeValue): unknown;
  recordException(exception: NativeException): void;
  /** Idempotent; no effect on the invocation root span. */
  end(): void;
  /** Added in the 2026-10-26 runtime release. */
  spanContext?(): NativeSpanContext;
  /**
   * Added in the 2026-10-26 runtime release. Applies OTel's rules: `ok` is
   * final, `unset` has no effect, the message is kept only with `error`, and
   * calls after `end()` are ignored.
   */
  setStatus?(status: NativeSpanStatus): unknown;
  /** Added in the 2026-10-26 runtime release. */
  updateName?(name: string): unknown;
};

/** Native tracing: async-context span activation. */
export type NativeTracing = {
  /**
   * Opens a span that is the active parent while `callback` runs. The caller
   * ends it; it stays open after `callback` returns but is no longer active.
   */
  startActiveSpan<T>(name: string, callback: (span: NativeSpan) => T): T;
  /**
   * The active span: the innermost custom span, or the invocation root span.
   * `undefined` outside a request.
   */
  getActiveSpan(): NativeSpan | undefined;
};

/** Returns `tracing` when it carries the methods the Agents SDK needs. */
export function resolveNativeTracing(
  tracing: unknown
): NativeTracing | undefined {
  const candidate = tracing as Partial<NativeTracing> | null | undefined;
  return typeof candidate?.startActiveSpan === "function" &&
    typeof candidate.getActiveSpan === "function"
    ? (candidate as NativeTracing)
    : undefined;
}
