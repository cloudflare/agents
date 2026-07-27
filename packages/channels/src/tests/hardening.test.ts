import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TurnPause } from "../types";
import {
  attemptConnector,
  freshName,
  Gate,
  inbound,
  journalText,
  makeEngine,
  noChunks,
  parkAfter,
  textPart,
  until
} from "./harness";

/**
 * Hardening tests for compound crashes and stale writers that the
 * single-fault chaos suite does not reach.
 */

async function withStorage<T>(
  name: string,
  fn: (storage: DurableObjectStorage) => Promise<T>
): Promise<T> {
  const stub = env.TestBed.get(env.TestBed.idFromName(freshName(name)));
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

describe("compound crashes", () => {
  it("survives a second kill during the recovery re-run", async () => {
    await withStorage("double-crash", async (storage) => {
      const parkFirst = new Gate();
      const parkSecond = new Gate();
      const connector = attemptConnector([
        // Crash 1: parked at ACCEPTED, nothing visible.
        () => parkAfter(noChunks(), parkFirst),
        // Recovery re-run — crash 2: parked mid-STREAM.
        () => parkAfter(textPart("p2", "second attempt "), parkSecond)
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(() => connector.runs.length === 1, "first run");

      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();
      await until(
        () => second.store.getTurn(turnId)?.state === "streaming",
        "recovery re-run streaming"
      );

      // Kill again. No resume capability means the third engine interrupts.
      const third = makeEngine({ connector, storage });
      await third.engine.ensureRecovered();

      const turn = third.store.getTurn(turnId);
      expect(turn?.state).toBe("settled");
      expect(turn?.outcome).toBe("interrupted");
      expect(journalText(third.store.listChunks(turnId, 0))).toBe(
        "second attempt "
      );
      expect(connector.runs).toHaveLength(2);
    });
  });

  it("survives a kill during a WAITING re-entry", async () => {
    await withStorage("reentry-crash", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector([
        async function* () {
          yield* textPart("q1", "Approve? ");
          throw new TurnPause({ id: "appr-1", kind: "approval" });
        },
        // The re-entered run streams its continuation, then dies.
        () => parkAfter(textPart("p2", "Approved, working "), park)
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(
        () => first.store.getTurn(turnId)?.state === "waiting",
        "waiting state"
      );
      await first.engine.submit({
        ...inbound("t1", "m2", "yes"),
        interaction: { id: "appr-1", value: "yes" }
      });
      await until(
        () =>
          journalText(first.store.listChunks(turnId, 0)).includes("working"),
        "continuation streaming"
      );

      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();

      const turn = second.store.getTurn(turnId);
      expect(turn?.outcome).toBe("interrupted");
      expect(second.store.listCompletedInteractions(turnId)).toHaveLength(1);
      expect(journalText(second.store.listChunks(turnId, 0))).toBe(
        "Approve? Approved, working "
      );
    });
  });
});

describe("stale writers", () => {
  it("a zombie execution cannot regress or extend a turn another engine settled", async () => {
    await withStorage("zombie-writer", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector([
        async function* (turn) {
          yield { id: "p1", type: "text-start" as const };
          yield { delta: "half ", id: "p1", type: "text-delta" as const };
          await park.passed;
          void turn;
          yield { delta: "ZOMBIE", id: "p1", type: "text-delta" as const };
          yield { id: "p1", type: "text-end" as const };
        }
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(
        () => first.store.getTurn(turnId)?.state === "streaming",
        "streaming state"
      );

      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();
      expect(second.store.getTurn(turnId)?.outcome).toBe("interrupted");
      const settledJournal = second.store.listChunks(turnId, 0).length;

      park.open();
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const turn = second.store.getTurn(turnId);
      expect(turn?.state).toBe("settled");
      expect(turn?.outcome).toBe("interrupted");
      expect(second.store.listChunks(turnId, 0)).toHaveLength(settledJournal);
      expect(journalText(second.store.listChunks(turnId, 0))).not.toContain(
        "ZOMBIE"
      );
    });
  });
});
