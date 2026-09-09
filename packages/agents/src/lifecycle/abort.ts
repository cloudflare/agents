/**
 * `DurableObjectState.abort()` accepts an options object newer than our
 * pinned `@cloudflare/workers-types`: `{ retryAlarm?: boolean }`. When
 * `retryAlarm` is false and the abort happens inside an alarm handler, the
 * platform does not retry that alarm (workerd `AbortOptions`,
 * `EXCEPTION_DURABLE_OBJECT_ABORT_NO_RETRY`). It has no effect outside an
 * alarm handler, and runtimes predating the option ignore the extra
 * argument, so passing it is always safe.
 */
type AbortWithOptions = (
  reason?: string,
  options?: { retryAlarm?: boolean }
) => void;

/**
 * Reset the Durable Object instance without the platform retrying the alarm
 * this invocation was handling. Never returns: `abort()` terminates
 * execution.
 */
export function abortWithoutAlarmRetry(
  ctx: DurableObjectState,
  reason: string
): void {
  (ctx.abort as AbortWithOptions)(reason, { retryAlarm: false });
}
