/**
 * Fault-injection tools for testing how an agent's Durable Object survives
 * being slow, starved, or killed.
 *
 * `sleep` and `get_current_time` drive long wall-clock turns. `oom` and
 * `burn_cpu` break the Durable Object on purpose: once deployed, the runtime
 * terminates the invocation for exceeding its memory or CPU limit, and the tool
 * call never returns. Use them to check recovery paths such as resumed chat
 * turns and fibers.
 *
 * Do not give these tools to a production agent.
 *
 * @example
 * ```ts
 * import { createTestingTools, testingPrompts } from "agents/tools/testing";
 *
 * class ChaosAgent extends Think<Env> {
 *   getTools() {
 *     return createTestingTools();
 *   }
 * }
 *
 * // Then send testingPrompts.longRunning, testingPrompts.oom or
 * // testingPrompts.burnCpu as a user message.
 * ```
 *
 * @module
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

const MIB = 1024 * 1024;

/**
 * Elements per `oom` chunk. `new Array(n)` stays in fast (contiguous) elements
 * mode below V8's 100,000-element threshold, so each chunk is one flat
 * float64 backing store in the JavaScript heap: 65,536 × 8 bytes = 512 KiB.
 * Keeping the allocation on the JS heap, not in ArrayBuffers, means the V8
 * heap limit trips inside the loop instead of waiting for an external-memory
 * check.
 */
const OOM_CHUNK_ELEMENTS = 65_536;
const OOM_CHUNK_BYTES = OOM_CHUNK_ELEMENTS * 8;

const DEFAULT_OOM_LIMIT_MIB = 512;
const DEFAULT_BURN_CPU_MS = 60_000;
const MAX_SLEEP_SECONDS = 3600;

/** Options for {@link createTestingTools}. */
export interface CreateTestingToolsOptions {
  /**
   * How much memory `oom` allocates before it gives up, in MiB.
   *
   * Deployed isolates are killed at 128 MB, long before the default of 512 is
   * reached. The cap only matters in local development, where workerd does not
   * enforce a memory limit and an unbounded loop would exhaust the host.
   */
  oomLimitMiB?: number;

  /**
   * How long `burn_cpu` spins, in milliseconds. Defaults to 60,000, twice the
   * default Durable Object CPU limit.
   *
   * Deployed Workers freeze `Date.now()` while code runs, so there the loop
   * never reaches this deadline and spins until the CPU limit (30 seconds by
   * default, up to 5 minutes with `limits.cpu_ms`) terminates the invocation.
   * The deadline only ends the loop in local development, where the clock
   * advances and CPU limits are not enforced.
   */
  burnCpuMs?: number;
}

/** Result of the `sleep` tool. */
export interface SleepResult {
  /** Wall-clock milliseconds that passed while sleeping. */
  sleptMs: number;
}

/** Result of the `get_current_time` tool. */
export interface CurrentTimeResult {
  /** The current time as an ISO 8601 string. */
  iso: string;
  /** The current time in milliseconds since the Unix epoch. */
  epochMs: number;
}

/** Result of the `oom` tool, returned only when no memory limit killed it. */
export interface OomResult {
  /** MiB allocated and held before reaching `oomLimitMiB`. */
  allocatedMiB: number;
}

/** Result of the `burn_cpu` tool, returned only when no CPU limit killed it. */
export interface BurnCpuResult {
  /** Milliseconds spent spinning without yielding. */
  burnedMs: number;
  /** Loop iterations completed. */
  iterations: number;
}

/** Input for the `sleep` tool. */
export interface SleepInput {
  /** How long to wait, in seconds. */
  seconds: number;
}

/** Input for the tools that take no arguments. */
export type NoInput = Record<string, never>;

/** The tools returned by {@link createTestingTools}. */
export type TestingTools = {
  /** Waits for a number of seconds. */
  sleep: Tool<SleepInput, SleepResult>;
  /** Returns the current time. */
  get_current_time: Tool<NoInput, CurrentTimeResult>;
  /** Allocates memory until the isolate is killed. */
  oom: Tool<NoInput, OomResult>;
  /** Spins without yielding until the invocation is killed. */
  burn_cpu: Tool<NoInput, BurnCpuResult>;
};

/**
 * Create the testing toolbox: `sleep`, `get_current_time`, `oom`, and
 * `burn_cpu`, as AI SDK tools.
 *
 * @param options - Local-development bounds for the destructive tools.
 * @returns A tool set to return from an agent's `getTools()` or pass to
 *   `streamText`.
 */
export function createTestingTools(
  options: CreateTestingToolsOptions = {}
): TestingTools {
  const oomLimitMiB = options.oomLimitMiB ?? DEFAULT_OOM_LIMIT_MIB;
  const burnCpuMs = options.burnCpuMs ?? DEFAULT_BURN_CPU_MS;

  return {
    sleep: tool({
      description:
        "Wait for the given number of seconds, then return how long the " +
        "wait took. Use get_current_time to check the time between sleeps.",
      inputSchema: z.object({
        seconds: z
          .number()
          .min(0)
          .max(MAX_SLEEP_SECONDS)
          .describe("How long to wait, in seconds.")
      }),
      execute: ({ seconds }, { abortSignal }) =>
        sleep(seconds * 1000, abortSignal)
    }),

    get_current_time: tool({
      description:
        "Get the current date and time as an ISO 8601 string and as " +
        "milliseconds since the Unix epoch.",
      inputSchema: z.object({}),
      execute: (): CurrentTimeResult => {
        const now = Date.now();
        return { iso: new Date(now).toISOString(), epochMs: now };
      }
    }),

    oom: tool({
      description:
        "Testing tool that deliberately runs the Durable Object out of " +
        "memory. It allocates memory without releasing it until the runtime " +
        "kills the isolate for exceeding its 128 MB limit. When deployed, the " +
        "call does not return. A result means no memory limit was enforced.",
      inputSchema: z.object({}),
      execute: (): OomResult => exhaustMemory(oomLimitMiB)
    }),

    burn_cpu: tool({
      description:
        "Testing tool that deliberately exceeds the Durable Object CPU limit. " +
        "It spins synchronously, without yielding to the event loop, until " +
        "the runtime terminates the invocation. When deployed, the call does " +
        "not return. A result means no CPU limit was enforced.",
      inputSchema: z.object({}),
      execute: (): BurnCpuResult => burnCpu(burnCpuMs)
    })
  };
}

/** Options for {@link longRunningPrompt}. */
export interface LongRunningPromptOptions {
  /** How long the turn should run, in minutes. Defaults to 30. */
  minutes?: number;
  /** How long each `sleep` call waits, in seconds. Defaults to 60. */
  sleepSeconds?: number;
}

/**
 * Build a prompt that keeps one turn running for a set wall-clock time by
 * alternating `sleep` and `get_current_time` calls.
 *
 * @param options - Total duration and sleep interval.
 * @returns The prompt to send as a user message.
 */
export function longRunningPrompt({
  minutes = 30,
  sleepSeconds = 60
}: LongRunningPromptOptions = {}): string {
  return [
    "This is a long-running test.",
    "Call get_current_time and remember the result as the start time.",
    `Then repeat: call sleep with seconds set to ${sleepSeconds}, then call get_current_time.`,
    `If less than ${minutes} minutes have passed since the start time, keep going.`,
    `Once ${minutes} minutes or more have passed, stop and reply with the start time, the end time, and how many times you called sleep.`
  ].join(" ");
}

/** Prompts that exercise each tool from {@link createTestingTools}. */
export const testingPrompts = {
  /** Keep one turn running for 30 minutes with a sleep every 60 seconds. */
  longRunning: longRunningPrompt(),
  /** Run the Durable Object out of memory. */
  oom: "Call the oom tool.",
  /** Exceed the Durable Object CPU limit. */
  burnCpu: "Call the burn_cpu tool."
} as const;

function sleep(
  ms: number,
  signal: AbortSignal | undefined
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
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function exhaustMemory(limitMiB: number): OomResult {
  const limitBytes = limitMiB * MIB;
  const retained: number[][] = [];
  while (retained.length * OOM_CHUNK_BYTES < limitBytes) {
    // A distinct non-integer per chunk forces float64 elements and stops V8
    // from sharing or compressing the backing stores.
    retained.push(
      new Array<number>(OOM_CHUNK_ELEMENTS).fill(retained.length + 0.5)
    );
  }
  return { allocatedMiB: (retained.length * OOM_CHUNK_BYTES) / MIB };
}

function burnCpu(durationMs: number): BurnCpuResult {
  const start = Date.now();
  const deadline = start + durationMs;
  let iterations = 0;
  // Never await in here: the point is to hold the event loop until the CPU
  // limit fires. See `CreateTestingToolsOptions.burnCpuMs` for why the
  // deadline is only reached locally.
  while (Date.now() < deadline) {
    iterations++;
  }
  return { burnedMs: Date.now() - start, iterations };
}
