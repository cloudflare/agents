/**
 * The testing toolbox from `agents/tools/testing` as AI SDK tools.
 *
 * @example
 * ```ts
 * import { testingPrompts } from "agents/tools/testing";
 * import { createTestingTools } from "agents/tools/testing/ai";
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
import {
  burnCpu,
  currentTime,
  fillMemory,
  generateBytes,
  sleep,
  type BurnCpuResult,
  type CurrentTimeResult,
  type SleepResult
} from "./index";

const MAX_SLEEP_SECONDS = 3600;

/** Options for {@link createTestingTools}. */
export interface CreateTestingToolsOptions {
  /**
   * Where `burn_cpu` reads its bytes from. Return a `fetch()` of an endpoint
   * that serves `generateBytes()` to burn CPU between network reads, like a
   * tool processing a large download.
   *
   * Defaults to an in-process `generateBytes()` response. Reading it never
   * waits on I/O, so the burn holds the event loop until the CPU limit fires,
   * and in local development, where no CPU limit applies, it never ends.
   */
  bytes?: () => Promise<Response>;
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
  current_time: Tool<NoInput, CurrentTimeResult>;
  /** Fills memory until the isolate is killed. Never returns. */
  oom: Tool<NoInput, void>;
  /** Hashes an endless byte stream until the invocation is killed. */
  burn_cpu: Tool<NoInput, BurnCpuResult>;
};

/**
 * Create the testing toolbox as AI SDK tools: `sleep`, `current_time`, `oom`,
 * and `burn_cpu`. The tool names match the prompts in
 * `agents/tools/testing`.
 *
 * @param options - Where `burn_cpu` reads bytes from.
 * @returns A tool set to return from an agent's `getTools()` or pass to
 *   `streamText`.
 */
export function createTestingTools(
  options: CreateTestingToolsOptions = {}
): TestingTools {
  const bytes = options.bytes ?? (async () => generateBytes());

  return {
    sleep: tool({
      description:
        "Wait for the given number of seconds, then return how long the " +
        "wait took.",
      inputSchema: z.object({
        seconds: z
          .number()
          .min(0)
          .max(MAX_SLEEP_SECONDS)
          .describe("How long to wait, in seconds.")
      }),
      execute: ({ seconds }, { abortSignal }) => sleep(seconds, abortSignal)
    }),

    current_time: tool({
      description:
        "Get the current date and time as an ISO 8601 string and as " +
        "milliseconds since the Unix epoch.",
      inputSchema: z.object({}),
      execute: () => currentTime()
    }),

    oom: tool({
      description:
        "Testing tool that deliberately crashes the server by filling memory " +
        "until the runtime kills it for exceeding its memory limit. It does " +
        "not return.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }): Promise<void> => {
        await fillMemory(abortSignal);
      }
    }),

    burn_cpu: tool({
      description:
        "Testing tool that deliberately crashes the server by hashing an " +
        "endless byte stream until the runtime terminates it for exceeding " +
        "its CPU limit. It does not return.",
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) =>
        burnCpu(await bytes(), abortSignal)
    })
  };
}
