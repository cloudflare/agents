import { describe, expect, it, vi } from "vitest";
import { withCapabilityHarness } from "../shared/capability-harness";
import { StateManager, type StateChangeSource } from "../../state";

/**
 * Capability-level StateManager tests: the capability installed on a minimal
 * real Durable Object through a real Lifecycle over real SQLite storage — no
 * fakes. Rehydration is proven by installing a fresh StateManager (empty
 * in-memory cache) over the same storage, the way a hibernation wake-up
 * rebuilds the instance. Agent's `state`/`setState` surface is covered by
 * ../state.test.ts.
 */

describe("StateManager capability", () => {
  it("reads state before lifecycle startup", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(new StateManager<number>());

      expect(capability.get()).toBeUndefined();

      await lifecycle.start();
    });
  });

  it("persists state before lifecycle startup", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const first = install(new StateManager<number>());

      first.capability.set(1);
      expect(first.capability.get()).toBe(1);

      await first.lifecycle.start();
      const second = install(new StateManager<number>());
      await second.lifecycle.start();
      expect(second.capability.get()).toBe(1);
    });
  });

  it("persists a state value and reads it back", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(new StateManager());
      await lifecycle.start();

      capability.set({ count: 1 });
      expect(capability.get()).toEqual({ count: 1 });
    });
  });

  it("returns undefined with no initial state and nothing stored", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(new StateManager());
      await lifecycle.start();

      expect(capability.get()).toBeUndefined();
    });
  });

  it("seeds the initial state on first access", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(
        new StateManager<{ n: number }>({
          initialState: { n: 42 }
        })
      );
      await lifecycle.start();

      expect(capability.get()).toEqual({ n: 42 });
    });
  });

  it("treats falsy stored values as set (row existence is the signal)", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(
        new StateManager<number>({
          initialState: 99
        })
      );
      await lifecycle.start();

      capability.set(0);
      // 0 is falsy but the row exists, so it must read back as 0, not the
      // initial state.
      expect(capability.get()).toBe(0);
    });
  });

  it("rehydrates persisted state across an eviction (fresh instance, same storage)", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const first = install(new StateManager<{ v: string }>());
      await first.lifecycle.start();
      first.capability.set({ v: "kept" });

      // Simulate a hibernation wake-up: a brand-new capability over the same
      // storage, with an empty in-memory cache.
      const second = install(new StateManager<{ v: string }>());
      await second.lifecycle.start();

      expect(second.capability.get()).toEqual({ v: "kept" });
    });
  });

  it("runs the injected validation hook and propagates its throw", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(
        new StateManager<number>({
          validateStateChange: (next) => {
            if (next < 0) throw new Error("no negatives");
          }
        })
      );
      await lifecycle.start();

      expect(() => capability.set(-1)).toThrow("no negatives");
      // Rejected change must not persist.
      expect(capability.get()).toBeUndefined();

      capability.set(5);
      expect(capability.get()).toBe(5);
    });
  });

  it("calls onChanged with the server source", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const events: Array<[number, StateChangeSource]> = [];
      const { capability, lifecycle } = install(
        new StateManager<number>({
          onChanged: (state, source) => {
            events.push([state, source]);
          }
        })
      );
      await lifecycle.start();

      capability.set(7);

      expect(events).toEqual([[7, "server"]]);
    });
  });

  it("calls onChanged with the originating connection", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const events: Array<[number, StateChangeSource]> = [];
      const { capability, lifecycle } = install(
        new StateManager<number>({
          onChanged: (state, source) => {
            events.push([state, source]);
          }
        })
      );
      await lifecycle.start();

      const connection = { id: "conn-123" } as never;
      capability.set(8, connection);

      expect(events).toEqual([[8, connection]]);
    });
  });

  it("does not reject a persisted change when onChanged throws", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability, lifecycle } = install(
        new StateManager<number>({
          onChanged: () => {
            throw new Error("hook failed");
          }
        })
      );
      await lifecycle.start();

      expect(() => capability.set(9)).not.toThrow();
      expect(capability.get()).toBe(9);
    });
  });

  it("tracks async onChanged work without making set async", async () => {
    await withCapabilityHarness(async ({ install }) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events: number[] = [];
      const { capability, lifecycle } = install(
        new StateManager<number>({
          onChanged: async (state) => {
            await gate;
            events.push(state);
          }
        })
      );
      await lifecycle.start();

      expect(capability.set(10)).toBeUndefined();
      expect(capability.get()).toBe(10);
      expect(events).toEqual([]);

      release();
      await vi.waitFor(() => expect(events).toEqual([10]));
    });
  });

  it("reports an async onChanged rejection without rejecting the change", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await withCapabilityHarness(async ({ install }) => {
        const { capability, lifecycle } = install(
          new StateManager<number>({
            onChanged: async () => {
              await Promise.resolve();
              throw new Error("async hook failed");
            }
          })
        );
        await lifecycle.start();

        expect(capability.set(11)).toBeUndefined();
        expect(capability.get()).toBe(11);
        await vi.waitFor(() =>
          expect(consoleError).toHaveBeenCalledWith(
            "StateManager onChanged hook failed:",
            expect.objectContaining({ message: "async hook failed" })
          )
        );
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
