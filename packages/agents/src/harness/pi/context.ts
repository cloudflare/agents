import type { Harness } from "@earendil-works/pi-durable";

/**
 * pi's invocation context, as `@earendil-works/chord` defines it.
 *
 * pi-durable takes a chord `Context` on every call but does not re-export
 * the type or its constructors. The harness needs only a background context
 * and a way to add an abort signal, so both are inlined here instead of
 * depending on chord directly. A chord `Context` is a plain structural
 * interface (an abort signal, keyed values, and a name), so these interoperate
 * with chord's own contexts inside pi.
 *
 * One limit: chord's own derived contexts read the abort signal through a
 * private key rather than `abortSignal`, so a chord `withContextValue`
 * wrapped around one of these would not see its signal. pi-durable does not
 * use `withContextValue` to wrap a caller's context that way; `withAbortSignal`
 * and `withCancel` read `abortSignal` and work.
 *
 * If pi-durable starts re-exporting chord's context helpers, replace this
 * file with those.
 */
export type Context = Parameters<Harness["close"]>[0];

/** chord's `BACKGROUND_CONTEXT`: no values, never cancelled. */
export const BACKGROUND_CONTEXT: Context = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context pi-harness background]"
});

/**
 * chord's `withAbortSignal`: a context cancelled by either the parent's
 * signal or `signal`, carrying the parent's values.
 */
export function withAbortSignal(signal: AbortSignal, parent: Context): Context {
  const abortSignal =
    parent.abortSignal === undefined
      ? signal
      : AbortSignal.any([parent.abortSignal, signal]);
  return Object.freeze({
    abortSignal,
    value: parent.value.bind(parent),
    toString: () => `${parent}.WithAbortSignal`
  });
}
