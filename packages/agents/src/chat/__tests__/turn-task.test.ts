import { describe, expect, it, vi } from "vitest";
import type { TaskJson, TaskStep } from "../../tasks";
import { unwrapChatFiberSnapshot } from "../recovery";
import {
  createChatTurnTaskDefinition,
  type ChatTurnClosureEntry
} from "../turn-task";

/** A step that runs `do` at once and keeps the checkpoint as JSON text. */
function fakeStep(local: unknown): {
  step: TaskStep;
  checkpoint: Map<string, string>;
} {
  const checkpoint = new Map<string, string>();
  const step = {
    local,
    createdAt: 1,
    interrupted: null,
    checkpoint: {
      get: (key: string) => {
        const value = checkpoint.get(key);
        return value === undefined ? undefined : JSON.parse(value);
      },
      set: (key: string, value: TaskJson) => {
        checkpoint.set(key, JSON.stringify(value));
      }
    },
    do: async (
      _name: string,
      _config: unknown,
      fn: (attempt: { signal: AbortSignal }) => Promise<unknown>
    ) => fn({ signal: new AbortController().signal })
  } as unknown as TaskStep;
  return { step, checkpoint };
}

const hooks = {
  storage: {} as DurableObjectStorage,
  snapshotKey: "__snapshot",
  keepAliveWhile: <T>(fn: () => Promise<T>) => fn(),
  withStash: <T>(
    context: { stash: (data: unknown) => void },
    fn: () => Promise<T>
  ) => {
    context.stash({ step: 1 });
    return fn();
  },
  recover: async () => {}
};

describe("createChatTurnTaskDefinition", () => {
  it("runs a live turn whose stash data cannot be kept as JSON, and settles its caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolve = vi.fn();
    const reject = vi.fn();
    const entry: ChatTurnClosureEntry = {
      onStash: () => {},
      run: (inside) => inside(async () => "reply"),
      settle: { resolve, reject }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition({
      ...hooks,
      withStash: (context, fn) => {
        context.stash({ count: 1n });
        return fn();
      }
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(resolve).toHaveBeenCalledWith("reply");
    expect(reject).not.toHaveBeenCalled();
    expect(checkpoint.size).toBe(0);
    warn.mockRestore();
  });

  it("keeps only the app's stash data in the checkpoint", async () => {
    const stashed: unknown[] = [];
    const entry: ChatTurnClosureEntry = {
      onStash: (data) => void stashed.push(data),
      run: (inside) => inside(async () => "reply"),
      settle: { resolve: () => {}, reject: () => {} }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition(hooks)(
      {
        requestId: "r1",
        continuation: false,
        nonce: "n1",
        envelope: { __snapshot: { s: 1 }, user: null }
      },
      step
    );
    expect(stashed).toEqual([{ step: 1 }]);
    expect([...checkpoint.keys()]).toEqual(["stash"]);
    expect(JSON.parse(checkpoint.get("stash")!)).toEqual({ step: 1 });
  });

  it("clears the stash data on stash(undefined)", async () => {
    const entry: ChatTurnClosureEntry = {
      onStash: () => {},
      run: (inside) => inside(async () => "reply"),
      settle: { resolve: () => {}, reject: () => {} }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition({
      ...hooks,
      withStash: (context, fn) => {
        context.stash({ step: 1 });
        context.stash(undefined);
        return fn();
      }
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(JSON.parse(checkpoint.get("stash")!)).toBeNull();
  });

  it("hands a replay the input's snapshot with the last stash data", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set("stash", JSON.stringify({ step: 3 }));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })(
      {
        requestId: "r1",
        continuation: false,
        nonce: "n1",
        envelope: { __snapshot: { s: 1 }, user: null }
      },
      step
    );
    expect(recovered).toEqual([{ __snapshot: { s: 1 }, user: { step: 3 } }]);
  });

  it("hands a replay whose snapshot could not be kept the app's stash data", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set("stash", JSON.stringify({ step: 4 }));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(recovered).toEqual([{ __snapshot: null, user: { step: 4 } }]);
    // Read back, it is the app's data, even when that data looks like an
    // envelope.
    expect(unwrapChatFiberSnapshot("__snapshot", recovered[0])).toEqual({
      snapshot: null,
      user: { step: 4 }
    });
  });

  it("hands a replay of a run from before the input carried it the envelope it checkpointed", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set(
      "snapshot",
      JSON.stringify({ __snapshot: { s: 0 }, user: { step: 9 } })
    );
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })({ requestId: "r1", nonce: "n1" }, step);
    expect(recovered).toEqual([{ __snapshot: { s: 0 }, user: { step: 9 } }]);
  });
});
