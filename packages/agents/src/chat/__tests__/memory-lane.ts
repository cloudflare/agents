import type { TurnLaneRun } from "../turn-lane";
import type { ChatLaneEntry } from "../turn-task";

/**
 * A chat lane in memory: the turns' runs one at a time, in the order they
 * were accepted, as the Tasks lane runs them.
 */
export function memoryLaneRun(): TurnLaneRun {
  let tail: Promise<void> = Promise.resolve();
  return async (_requestId: string, entry: ChatLaneEntry) => {
    tail = tail.then(async () => {
      try {
        await entry.run((fn) => fn());
      } catch {
        // The turn's caller got the throw.
      } finally {
        entry.dropped();
      }
    });
  };
}

/** {@link memoryLaneRun} as `ChatTurnsOptions.lane`. */
export function memoryLane() {
  const run = memoryLaneRun();
  return {
    tasks: () => ({
      run: async (
        _definition: string,
        input: unknown,
        options?: { local?: unknown }
      ) => {
        await run(
          (input as { requestId: string }).requestId,
          options?.local as ChatLaneEntry
        );
        return {
          runId: "run",
          definition: "turn",
          accepted: true,
          status: "pending" as const,
          createdAt: Date.now()
        };
      }
    }),
    definition: "turn"
  };
}
