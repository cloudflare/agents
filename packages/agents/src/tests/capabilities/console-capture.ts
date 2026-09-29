/**
 * Capture `console.warn` output emitted while `run` executes, so warning
 * behavior can be asserted through its observable output instead of
 * implementation internals. Restores the original writer even when `run`
 * throws.
 *
 * @param sink - Receives the first argument of every captured warning.
 * @param run - The operation whose warnings should be captured.
 */
export async function captureConsoleWarnings(
  sink: string[],
  run: () => Promise<void>
): Promise<void> {
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    sink.push(String(args[0]));
    original.apply(console, args);
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
}
