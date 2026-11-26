import type { TurnLaneRun } from "../turn-lane";
import type { TaskJson, Tasks } from "../../tasks";
import type { ChatAdmissionInput, ChatAdmissionRecord } from "../admissions";
import type { ChatLaneEntry } from "../turn-task";

/**
 * A chat lane in memory: the turns' runs one at a time, in the order they
 * were accepted, as the Tasks lane runs them.
 */
export function memoryLaneRun(): TurnLaneRun {
  let tail: Promise<void> = Promise.resolve();
  let runs = 0;
  return async (_requestId: string, entry: ChatLaneEntry) => {
    const runId = `run-${++runs}`;
    tail = tail.then(async () => {
      try {
        await entry.run((fn) => fn());
      } catch {
        // The turn's caller got the throw.
      } finally {
        entry.dropped();
      }
    });
    return { runId };
  };
}

/** One run of the chat lane, as every isolate of one object sees it. */
export interface MemoryRun {
  runId: string;
  input: { requestId: string; admission?: ChatAdmissionInput };
  metadata: Record<string, TaskJson>;
  seq: number;
  status: "pending" | "running";
  /** Arrived under `latest` or a debounce: a later such arrival skips it. */
  supersedable: boolean;
  /** When a debounced run may start. */
  startAt: number;
}

/** The chat lane's runs of one object, across its isolates. */
export class MemoryWorld {
  readonly runs = new Map<string, MemoryRun>();
  /** Requests whose model call began: their run is recovery's. */
  readonly began = new Set<string>();
  /** List the lane's runs newest first, as a tie in the listing can. */
  listReversed = false;
  /** Continuation records' keys. */
  readonly keys = new Map<string, unknown>();
  seq = 0;
  /** The client requests waiting in the lane, in order. */
  waiting(): string[] {
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.input.admission &&
          !this.began.has(run.input.requestId) &&
          (run.metadata.chat as { cleared?: boolean } | undefined)?.cleared !==
            true
      )
      .sort((a, b) => a.seq - b.seq)
      .map((run) => run.input.requestId);
  }
}

/**
 * The chat lane as one isolate's Tasks runs it, over `world`: the runs of
 * this isolate whose caller holds their entry run in lane order, and
 * {@link wake} runs what an earlier isolate left (as a restart's wake does).
 */
export function memoryLane(world = new MemoryWorld()) {
  const locals = new Map<string, ChatLaneEntry>();
  let replay:
    | ((runId: string, record: ChatAdmissionRecord) => Promise<void>)
    | undefined;
  let pumping = false;
  const open = () => [...world.runs.values()].sort((a, b) => a.seq - b.seq);
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const head = open()[0];
        if (!head) return;
        if (head.startAt > Date.now()) {
          // In short steps: a cancel or a skip can change the head meanwhile.
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(head.startAt - Date.now(), 5))
          );
          continue;
        }
        const entry = locals.get(head.runId);
        if (entry) {
          locals.delete(head.runId);
          head.status = "running";
          try {
            await entry.run((fn) => fn());
          } catch {
            // The turn's caller got the throw.
          } finally {
            entry.dropped();
            world.runs.delete(head.runId);
          }
          continue;
        }
        if (!replay) return;
        // An earlier isolate's run: one that was running is recovery's (it
        // ends here), one still waiting runs again from its record.
        const admission = head.input.admission;
        head.status = "running";
        if (admission && !world.began.has(head.input.requestId)) {
          await replay(head.runId, {
            requestId: head.input.requestId,
            seq: head.seq,
            messageIds: admission.messages.map((message) => message.id),
            messages: admission.messages,
            afterUserId: admission.afterUserId,
            strategy: admission.strategy ?? null,
            payload: admission.payload,
            stopped: false,
            createdAt: 0
          });
        }
        world.runs.delete(head.runId);
      }
    } finally {
      pumping = false;
    }
  };
  return {
    world,
    definition: "turn",
    tasks: () =>
      ({
        run: async (
          _definition: string,
          input: unknown,
          options?: {
            runId?: string;
            local?: unknown;
            metadata?: Record<string, TaskJson>;
            policy?: "queue" | "latest" | "drop" | { debounceMs: number };
          }
        ) => {
          const runId = options?.runId ?? `run-${world.seq + 1}`;
          const policy = options?.policy ?? "queue";
          const busy = world.runs.size > 0;
          if (busy && policy === "drop") {
            return {
              runId,
              definition: "turn",
              accepted: false,
              dropped: true as const,
              status: "skipped" as const,
              createdAt: Date.now()
            };
          }
          // As the lane does: a debounce with no quiet period is a plain queue.
          const supersedable =
            policy === "latest" ||
            (typeof policy === "object" && policy.debounceMs > 0);
          // As the lane does: a superseding arrival skips the waiting runs
          // that arrived so too, in lane order.
          const superseded: string[] = [];
          if (busy && supersedable) {
            for (const run of open()) {
              if (run.status !== "pending" || !run.supersedable) continue;
              world.runs.delete(run.runId);
              superseded.push(run.runId);
              const local = locals.get(run.runId);
              locals.delete(run.runId);
              local?.dropped();
            }
          }
          if (world.runs.has(runId)) {
            return {
              runId,
              definition: "turn",
              accepted: false,
              status: "pending" as const,
              createdAt: Date.now()
            };
          }
          world.runs.set(runId, {
            runId,
            input: input as MemoryRun["input"],
            metadata: { ...options?.metadata },
            seq: ++world.seq,
            status: "pending",
            supersedable,
            // As the lane does: the quiet period only at a busy lane.
            startAt:
              Date.now() +
              (busy && typeof policy === "object" ? policy.debounceMs : 0)
          });
          if (options?.local) locals.set(runId, options.local as ChatLaneEntry);
          void pump();
          return {
            runId,
            definition: "turn",
            accepted: true,
            status: "pending" as const,
            createdAt: Date.now(),
            ...(superseded.length > 0 && { superseded })
          };
        },
        peek: (runId: string) => {
          const run = world.runs.get(runId);
          return run && { runId, metadata: run.metadata };
        },
        peekList: (options: { parked?: boolean }) => {
          // Nothing here parks.
          if (options.parked) return [];
          const runs = open().map((run) => ({
            runId: run.runId,
            metadata: run.metadata
          }));
          return world.listReversed ? runs.reverse() : runs;
        },
        inputOf: (runId: string) => world.runs.get(runId)?.input,
        patchMetadata: (
          runId: string,
          key: string,
          patch: Record<string, TaskJson | null>
        ) => {
          const run = world.runs.get(runId);
          if (!run) return false;
          run.metadata[key] = {
            ...(run.metadata[key] as Record<string, TaskJson> | undefined),
            ...patch
          };
          return true;
        },
        // Nothing here parks: an earlier isolate's park has ended.
        settle: async (runId: string) => world.runs.delete(runId),
        // A run that has not started ends; one that runs is left to end.
        cancel: async (runId: string) => {
          if (world.runs.get(runId)?.status !== "pending") return false;
          world.runs.delete(runId);
          const local = locals.get(runId);
          locals.delete(runId);
          local?.dropped();
          return true;
        }
      }) as unknown as Pick<
        Tasks,
        | "run"
        | "peek"
        | "peekList"
        | "inputOf"
        | "patchMetadata"
        | "settle"
        | "cancel"
      >,
    /** Run what earlier isolates left, replaying through `turns`. */
    wake(turns: {
      replayInRun(runId: string, record: ChatAdmissionRecord): Promise<void>;
    }): Promise<void> {
      replay = (runId, record) => turns.replayInRun(runId, record);
      return pump();
    }
  };
}

/** Continuation records' storage, in memory, for one object. */
export function memoryStorage(keys = new Map<string, unknown>()) {
  return {
    keys,
    storage: () =>
      ({
        put: async (key: string, value: unknown) => void keys.set(key, value),
        delete: async (key: string) => keys.delete(key),
        list: async (options?: { prefix?: string }) =>
          new Map(
            [...keys].filter(([key]) => key.startsWith(options?.prefix ?? ""))
          )
      }) as unknown as Pick<DurableObjectStorage, "put" | "delete" | "list">
  };
}
