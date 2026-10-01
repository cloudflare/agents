/**
 * Fault-injection building blocks for testing how an agent's Durable Object
 * survives being slow, starved, or killed in the middle of a turn.
 *
 * - {@link sleep} and {@link currentTime} drive a turn that runs for longer
 *   than the 15-minute alarm wall-time limit ({@link longRunningPrompt}).
 * - {@link fillMemory} fills an in-memory buffer until the runtime kills the
 *   isolate for exceeding its 128 MB memory limit.
 * - {@link burnCpu} processes a byte stream, such as a `fetch()` of
 *   {@link generateBytes}, until the runtime terminates the invocation for
 *   exceeding its CPU limit.
 *
 * The prompts run each one mid-turn and then give the model a
 * {@link secondaryTask}, so a test can check the turn recovered and finished.
 *
 * These are plain functions with no framework dependency. Wrap them in your
 * harness's tool format, or use `createTestingTools` from
 * `agents/tools/testing/ai` for AI SDK tools. Local workerd enforces neither
 * the memory nor the CPU limit, so `fillMemory` and `burnCpu` only break a
 * deployed Durable Object. Do not give them to a production agent.
 *
 * @module
 */

const MIB = 1024 * 1024;

/** `fillMemory` allocates this much per chunk. */
const FILL_CHUNK_BYTES = MIB;

/**
 * `fillMemory` yields to the event loop after this many chunks, so the
 * runtime can account for the memory and kill the isolate.
 */
const FILL_CHUNKS_PER_YIELD = 8;

/** `generateBytes` emits chunks of this size. */
const BYTES_CHUNK_SIZE = 64 * 1024;

/**
 * Hash rounds `burnCpu` spends on every byte. Hashing a byte once is cheaper
 * than receiving it, so a single round would leave the loop waiting on the
 * network. At 32 rounds the loop processes roughly 30 MB/s, slower than any
 * stream it reads, so it stays CPU-bound.
 */
const BURN_ROUNDS_PER_BYTE = 32;

/** Result of {@link sleep}. */
export interface SleepResult {
  /** Wall-clock milliseconds that passed while sleeping. */
  sleptMs: number;
}

/** Result of {@link currentTime}. */
export interface CurrentTimeResult {
  /** The current time as an ISO 8601 string. */
  iso: string;
  /** The current time in milliseconds since the Unix epoch. */
  epochMs: number;
}

/** Result of {@link burnCpu}, returned only when the stream ends first. */
export interface BurnCpuResult {
  /** Bytes read and hashed. */
  bytes: number;
  /** FNV-1a hash of the stream, so the work cannot be optimized away. */
  checksum: number;
}

/**
 * Wait for a number of seconds.
 *
 * @param seconds - How long to wait.
 * @param signal - Aborting it rejects with its reason and clears the timer.
 * @returns How long the wait took.
 */
export function sleep(
  seconds: number,
  signal?: AbortSignal
): Promise<SleepResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const start = Date.now();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ sleptMs: Date.now() - start });
    }, seconds * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read the current time.
 *
 * @returns The current time as ISO 8601 and as epoch milliseconds.
 */
export function currentTime(): CurrentTimeResult {
  const now = Date.now();
  return { iso: new Date(now).toISOString(), epochMs: now };
}

/**
 * Fill an in-memory buffer indefinitely. Deployed, the isolate is killed for
 * exceeding its memory limit within a second or so. Locally nothing stops it
 * except `signal`, so do not call it in local development without one.
 *
 * @param signal - Aborting it rejects with its reason and frees the buffer.
 * @returns A promise that never resolves.
 */
export async function fillMemory(signal?: AbortSignal): Promise<never> {
  const buffer: Uint8Array[] = [];
  for (;;) {
    signal?.throwIfAborted();
    for (let i = 0; i < FILL_CHUNKS_PER_YIELD; i++) {
      // Writing non-zero bytes commits the pages instead of leaving them as
      // untouched zero pages.
      buffer.push(new Uint8Array(FILL_CHUNK_BYTES).fill(0xa5));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * An endless stream of bytes, for an endpoint that {@link burnCpu} can
 * `fetch()`. Serve it from a route on your Worker.
 *
 * @returns A streaming `application/octet-stream` response that never ends.
 */
export function generateBytes(): Response {
  const chunk = new Uint8Array(BYTES_CHUNK_SIZE);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk.slice());
    }
  });
  return new Response(body, {
    headers: { "content-type": "application/octet-stream" }
  });
}

/**
 * Read a response body to the end, hashing every byte several times. The
 * hashing makes this CPU-bound, and CPU time spent between reads counts
 * toward the invocation's limit even though each read waits on I/O. Pass an
 * endless body, such as a `fetch()` of {@link generateBytes}, and a deployed
 * Durable Object is terminated when it exceeds its CPU limit (30 seconds by
 * default).
 *
 * @param response - The response whose body to consume.
 * @param signal - Aborting it cancels the body and rejects with its reason.
 * @returns The byte count and hash, once the body ends.
 */
export async function burnCpu(
  response: Response,
  signal?: AbortSignal
): Promise<BurnCpuResult> {
  signal?.throwIfAborted();
  let bytes = 0;
  let checksum = 0x811c9dc5;
  const body = response.body;
  if (body === null) return { bytes, checksum };
  const reader = body.getReader();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return { bytes, checksum: checksum >>> 0 };
      for (const byte of value) {
        for (let round = 0; round < BURN_ROUNDS_PER_BYTE; round++) {
          checksum = Math.imul(checksum ^ byte, 0x01000193);
        }
      }
      bytes += value.length;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * A short task the model does after the disruptive step, so a test can tell
 * the turn recovered and kept going. It needs one more tool call, which
 * proves tools still run after the restart.
 */
export const secondaryTask = {
  /** Appended to each prompt after "Then". */
  instruction:
    "call current_time once more, work out 47 × 19, and end your reply with a final line of the form `ANSWER: <number>`.",
  /** The number the final reply contains when the model finished the task. */
  answer: "893"
} as const;

/** Options for {@link longRunningPrompt}. */
export interface LongRunningPromptOptions {
  /** How long the turn should run, in minutes. Defaults to 30. */
  minutes?: number;
  /** How long each `sleep` call waits, in seconds. Defaults to 60. */
  sleepSeconds?: number;
  /** What to do afterwards. Defaults to {@link secondaryTask}. */
  then?: string;
}

/**
 * Build a prompt that keeps one turn running by alternating `sleep` and
 * `current_time`, then moves on to a secondary task. The default 30 minutes
 * is twice the 15-minute wall-time limit of an alarm invocation.
 *
 * @param options - Duration, sleep interval, and follow-on task.
 * @returns The prompt to send as a user message.
 */
export function longRunningPrompt({
  minutes = 30,
  sleepSeconds = 60,
  then = secondaryTask.instruction
}: LongRunningPromptOptions = {}): string {
  return [
    "This is a durability test. Follow these steps exactly.",
    "1. Call current_time and remember the result as the start time.",
    `2. Call sleep with seconds set to ${sleepSeconds}, then call current_time.`,
    `3. If less than ${minutes} minutes have passed since the start time, go back to step 2.`,
    `4. Once ${minutes} minutes or more have passed, stop looping. Then ${then}`
  ].join("\n");
}

/** A tool that deliberately kills the Durable Object. */
export type CrashTool = "oom" | "burn_cpu";

/** Options for {@link crashPrompt}. */
export interface CrashPromptOptions {
  /** What to do after the crash. Defaults to {@link secondaryTask}. */
  then?: string;
}

/**
 * Build a prompt that calls a crashing tool mid-turn, between two other tool
 * calls, and then moves on to a secondary task.
 *
 * @param tool - The tool that kills the Durable Object: `oom` or `burn_cpu`.
 * @param options - The follow-on task.
 * @returns The prompt to send as a user message.
 */
export function crashPrompt(
  tool: CrashTool,
  { then = secondaryTask.instruction }: CrashPromptOptions = {}
): string {
  return [
    "This is a durability test. Follow these steps exactly.",
    "1. Call current_time.",
    `2. Call ${tool} exactly once. It deliberately crashes the server, so expect its result to be an error saying it was interrupted. Do not call ${tool} again, whatever its result.`,
    `3. Then ${then}`
  ].join("\n");
}

/** Prompts for each scenario, with the default options. */
export const testingPrompts = {
  /** Run one turn for 30 minutes, sleeping 60 seconds at a time. */
  longRunning: longRunningPrompt(),
  /** Run out of memory mid-turn. */
  oom: crashPrompt("oom"),
  /** Exceed the CPU limit mid-turn. */
  burnCpu: crashPrompt("burn_cpu")
} as const;
