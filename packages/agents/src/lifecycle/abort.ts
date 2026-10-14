/**
 * Reset the Durable Object instance without the platform retrying the alarm
 * this invocation was handling. Never returns: `abort()` terminates
 * execution.
 *
 * `retryAlarm: false` only matters inside an alarm handler (workerd
 * `EXCEPTION_DURABLE_OBJECT_ABORT_NO_RETRY`). Runtimes older than the option
 * ignore the extra argument, so passing it is always safe.
 */
export function abortWithoutAlarmRetry(
  ctx: DurableObjectState,
  reason: string
): void {
  ctx.abort(reason, { retryAlarm: false });
}
