import { describe, expect, it, vi } from "vitest";
import type { TaskJson, TaskStep } from "../../tasks";
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
  it("runs a live turn whose snapshot cannot be kept as JSON, and settles its caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolve = vi.fn();
    const reject = vi.fn();
    const entry: ChatTurnClosureEntry = {
      // A delegated request body with a bigint in it.
      initial: { lastBody: { count: 1n } },
      wrap: (data) => ({ lastBody: { count: 2n }, user: data }),
      run: (inside) => inside(async () => "reply"),
      settle: { resolve, reject }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition(hooks)(
      { requestId: "r1", nonce: "n1" },
      step
    );
    expect(resolve).toHaveBeenCalledWith("reply");
    expect(reject).not.toHaveBeenCalled();
    expect(checkpoint.size).toBe(0);
    warn.mockRestore();
  });

  it("keeps the turn's snapshot and its stash data in the checkpoint", async () => {
    const entry: ChatTurnClosureEntry = {
      initial: { snapshot: "s" },
      wrap: (data) => ({ snapshot: "s", user: data as TaskJson }),
      run: (inside) => inside(async () => "reply"),
      settle: { resolve: () => {}, reject: () => {} }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition(hooks)(
      { requestId: "r1", nonce: "n1" },
      step
    );
    expect(JSON.parse(checkpoint.get("snapshot")!)).toEqual({
      snapshot: "s",
      user: { step: 1 }
    });
  });
});
