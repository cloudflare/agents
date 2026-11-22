import { DatabaseSync } from "node:sqlite";
import { bindLifecycleCapability } from "../../lifecycle/capability";
import type { LifecycleJob } from "../../lifecycle/job-queue";
import type { ChatLane } from "../chat-lane";

/**
 * A `ChatLane` for node unit tests of the turn core: its inbox runs on an
 * in-memory SQLite (`node:sqlite`) behind a minimal storage fake. Lanes
 * start in the calling invocation, so no alarm is needed; the fake job
 * queue only records pushes. Durability across resets is covered by the
 * workers tests (`src/tests/chat-lane`), not here.
 */
export function bindTestLane(lane: ChatLane): ChatLane {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const statement = db.prepare(query);
      const reads = statement.columns().length > 0;
      const rows = reads
        ? (statement.all(...(params as never[])) as Record<string, unknown>[])
        : [];
      const rowsWritten = reads
        ? 0
        : Number(statement.run(...(params as never[])).changes);
      return {
        rowsWritten,
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator]()
      };
    }
  };
  const jobs = new Map<string, LifecycleJob>();
  const storage = {
    sql,
    sync: async () => {}
  } as unknown as DurableObjectStorage;
  bindLifecycleCapability(lane.inbox, {
    name: "test",
    className: "TestLaneObject",
    storage,
    sockets: { accept: () => {}, get: () => [] },
    ready: async () => {},
    status: () => "started",
    jobs: {
      push: async (job) => {
        const stored = {
          id: job.id ?? crypto.randomUUID(),
          capability: lane.inbox.capabilityId,
          fn: job.fn,
          time: job.time,
          payload: job.payload,
          retry: undefined,
          singleflight: false,
          exclusive: false,
          recoveryLoop: false,
          createdAt: Date.now()
        } satisfies LifecycleJob;
        jobs.set(stored.id, stored);
        return stored;
      },
      cancel: async (id) => jobs.delete(id),
      reschedule: async (id) => jobs.has(id),
      get: (id) => jobs.get(id),
      list: () => [...jobs.values()],
      rearm: async () => {}
    },
    trackAlarmWork: () => false,
    runInHostContext: async (fn) => fn(),
    events: { emit: () => {} },
    routes: {
      source: undefined,
      toRoot: async () => undefined,
      to: async () => undefined
    }
  });
  return lane;
}
