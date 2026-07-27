import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { JOURNAL_RETENTION_MS } from "../engine/engine";
import { TurnPause, type AgentConnector } from "../types";
import {
  attemptConnector,
  FakeClock,
  Gate,
  inbound,
  journalText,
  makeEngine,
  freshName,
  noChunks,
  parkAfter,
  textPart,
  until
} from "./harness";

/**
 * The chaos suite: kill the engine at every state of the turn table and
 * assert the recovery behavior the table promises. A "kill" abandons the
 * running engine mid-turn and constructs a fresh engine over the same
 * storage — exactly what a process death looks like to the ledger.
 *
 * | Killed at   | Promise                                                |
 * | ----------- | ------------------------------------------------------ |
 * | `accepted`  | safe to re-run                                         |
 * | `streaming` | resume exactly (capability) or apologize — never both  |
 * | `waiting`   | no-op; completion re-enters later                      |
 * | `settled`   | retry is a no-op                                       |
 */

async function withStorage<T>(
  name: string,
  fn: (storage: DurableObjectStorage) => Promise<T>
): Promise<T> {
  const stub = env.TestBed.get(env.TestBed.idFromName(freshName(name)));
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

describe("turn lifecycle", () => {
  it("runs one inbound message to exactly one settled outcome", async () => {
    await withStorage("lifecycle-happy", async (storage) => {
      const connector = attemptConnector([
        () => textPart("p1", "Hello ", "world")
      ]);
      const { engine, store, wakes } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "hi"));
      expect(admission.kind).toBe("new");
      const turn = await engine.waitForSettlement(admission.turn!.id);

      expect(turn.state).toBe("settled");
      expect(turn.outcome).toBe("ok");
      const journal = store.listChunks(turn.id, 0);
      expect(journalText(journal)).toBe("Hello world");
      // The retention wake was armed at settlement.
      expect(wakes).toContain(turn.settledAt! + JOURNAL_RETENTION_MS);
      expect(connector.runs[0]?.conversationId).toBe("t1");
      expect(connector.runs[0]?.origin).toBe("inbound");
    });
  });

  it("absorbs a redelivery of a settled turn without re-running", async () => {
    await withStorage("lifecycle-absorb", async (storage) => {
      const connector = attemptConnector([() => textPart("p1", "once")]);
      const { engine } = makeEngine({ connector, storage });

      const first = await engine.submit(inbound("t1", "m1", "hi"));
      await engine.waitForSettlement(first.turn!.id);
      const retry = await engine.submit(inbound("t1", "m1", "hi"));

      expect(retry.kind).toBe("absorbed");
      expect(retry.turn?.id).toBe(first.turn!.id);
      expect(connector.runs).toHaveLength(1);
    });
  });

  it("scopes source event ids to their conversation", async () => {
    await withStorage("lifecycle-source-scope", async (storage) => {
      const connector = attemptConnector([() => textPart("p1", "done")]);
      const { engine } = makeEngine({ connector, storage });

      const first = await engine.submit(inbound("one", "same-id", "first"));
      const second = await engine.submit(inbound("two", "same-id", "second"));

      expect(first.kind).toBe("new");
      expect(second.kind).toBe("new");
      expect(first.turn?.id).not.toBe(second.turn?.id);
      await Promise.all([
        engine.waitForSettlement(first.turn!.id),
        engine.waitForSettlement(second.turn!.id)
      ]);
    });
  });

  it("joins a duplicate onto the in-flight turn", async () => {
    await withStorage("lifecycle-join", async (storage) => {
      const gate = new Gate();
      const connector = attemptConnector([
        () => parkAfter(textPart("p1", "working"), gate)
      ]);
      const { engine } = makeEngine({ connector, storage });

      const first = await engine.submit(inbound("t1", "m1", "hi"));
      const duplicate = await engine.submit(inbound("t1", "m1", "hi"));
      expect(duplicate.kind).toBe("joined");
      expect(duplicate.turn?.id).toBe(first.turn!.id);

      gate.open();
      await engine.waitForSettlement(first.turn!.id);
      expect(connector.runs).toHaveLength(1);
    });
  });

  it("admits agent-initiated turns — nothing assumes an inbound message", async () => {
    await withStorage("lifecycle-agent-origin", async (storage) => {
      const connector = attemptConnector([() => textPart("p1", "reminder")]);
      const { engine } = makeEngine({ connector, storage });

      const admission = await engine.submit({
        conversationId: "t1",
        input: [],
        origin: "agent"
      });
      const turn = await engine.waitForSettlement(admission.turn!.id);

      expect(turn.origin).toBe("agent");
      expect(turn.outcome).toBe("ok");
      expect(connector.runs[0]?.origin).toBe("agent");
    });
  });

  it("settles a turn that fails before visible output as the error outcome", async () => {
    await withStorage("lifecycle-early-error", async (storage) => {
      const connector = attemptConnector([
        // eslint-disable-next-line require-yield
        async function* () {
          throw new Error("model unavailable");
        }
      ]);
      const { engine, store } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "hi"));
      const turn = await engine.waitForSettlement(admission.turn!.id);

      expect(turn.outcome).toBe("error");
      expect(turn.errorText).toBe("model unavailable");
      expect(store.listChunks(turn.id, 0)).toHaveLength(0);
    });
  });
});

describe("kill at ACCEPTED", () => {
  it("re-runs safely on the first event after restart", async () => {
    await withStorage("chaos-accepted", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector([
        () => parkAfter(noChunks(), park),
        () => textPart("p1", "recovered ", "answer")
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "hi"));
      const turnId = admission.turn!.id;
      await until(() => connector.runs.length === 1, "first run to start");
      expect(first.store.getTurn(turnId)?.state).toBe("accepted");

      // Kill. The recovery scan runs on the first event after restart —
      // an unrelated message, not a redelivery of the lost one.
      const second = makeEngine({ connector, storage });
      await second.engine.submit(inbound("t-other", "m9", "unrelated"));

      const turn = await second.engine.waitForSettlement(turnId);
      expect(turn.outcome).toBe("ok");
      expect(connector.runs.length).toBeGreaterThanOrEqual(2);
      expect(journalText(second.store.listChunks(turnId, 0))).toBe(
        "recovered answer"
      );
      expect(
        second.recovered.some(
          (r) => r.turn.id === turnId && r.resolution === "rerun"
        )
      ).toBe(true);
    });
  });

  it("drops stale invisible frames before the re-run", async () => {
    await withStorage("chaos-accepted-frames", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector([
        // Crash after opening a part but before any visible byte: the
        // journal holds a dangling text-start, the ledger stays accepted.
        async function* () {
          yield { id: "p0", type: "text-start" as const };
          await park.passed;
        },
        () => textPart("p1", "clean")
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "hi"));
      const turnId = admission.turn!.id;
      await until(
        () => first.store.listChunks(turnId, 0).length === 1,
        "dangling frame"
      );
      expect(first.store.getTurn(turnId)?.state).toBe("accepted");

      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();
      await second.engine.waitForSettlement(turnId);

      const journal = second.store.listChunks(turnId, 0);
      expect(journal.map((entry) => entry.chunk.type)).toEqual([
        "text-start",
        "text-delta",
        "text-end"
      ]);
      expect(journalText(journal)).toBe("clean");
    });
  });
});

describe("kill at STREAMING", () => {
  it("apologizes when the connector cannot resume: partial stays, one interrupted outcome", async () => {
    await withStorage("chaos-streaming-apology", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector([
        async function* () {
          yield { id: "p1", type: "text-start" as const };
          yield { delta: "Half an ans", id: "p1", type: "text-delta" as const };
          await park.passed;
        }
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "hi"));
      const turnId = admission.turn!.id;
      await until(
        () => first.store.getTurn(turnId)?.state === "streaming",
        "streaming state"
      );

      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();

      const turn = second.store.getTurn(turnId);
      expect(turn?.state).toBe("settled");
      expect(turn?.outcome).toBe("interrupted");
      // The partial was real output: it stays, and the journal is closed
      // so a replay is well-formed.
      const journal = second.store.listChunks(turnId, 0);
      expect(journalText(journal)).toBe("Half an ans");
      expect(journal.at(-1)?.chunk.type).toBe("text-end");
      // The connector was never re-run — a re-run could double-answer.
      expect(connector.runs).toHaveLength(1);
      expect(
        second.recovered.some(
          (r) => r.turn.id === turnId && r.resolution === "apologized"
        )
      ).toBe(true);
    });
  });

  it("resumes exactly when the connector declares resume: every byte once", async () => {
    await withStorage("chaos-streaming-resume", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector(
        [
          async function* () {
            yield { id: "p1", type: "text-start" as const };
            yield { delta: "Hel", id: "p1", type: "text-delta" as const };
            yield { delta: "lo ", id: "p1", type: "text-delta" as const };
            await park.passed;
          },
          // The recovery run replays from the connector's checkpoint, so
          // it re-emits the already-journaled overlap under a fresh part
          // id — exactly what an offset-replaying connector does.
          () => textPart("p2", "Hel", "lo ", "wor", "ld!")
        ],
        { resume: true }
      );

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "hi"));
      const turnId = admission.turn!.id;
      await until(
        () => journalText(first.store.listChunks(turnId, 0)) === "Hello ",
        "partial stream"
      );

      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();
      const turn = await second.engine.waitForSettlement(turnId);

      expect(turn.outcome).toBe("ok");
      expect(journalText(second.store.listChunks(turnId, 0))).toBe(
        "Hello world!"
      );
      expect(
        second.recovered.some(
          (r) => r.turn.id === turnId && r.resolution === "resumed"
        )
      ).toBe(true);
    });
  });
});

describe("kill at WAITING", () => {
  it("leaves the durable wait alone; the completion re-enters as an ordinary event", async () => {
    await withStorage("chaos-waiting", async (storage) => {
      const connector = attemptConnector([
        async function* () {
          yield* textPart("q1", "Deploy to prod?");
          throw new TurnPause({
            id: "appr-1",
            kind: "approval",
            payload: { action: "deploy" }
          });
        },
        () => textPart("p2", "Deployed.")
      ]);

      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "ship"));
      const turnId = admission.turn!.id;
      await until(
        () => first.store.getTurn(turnId)?.state === "waiting",
        "waiting state"
      );

      // Kill. Recovery must not touch the wait — it only reports it so the
      // embedding can redeliver the pre-pause segment.
      const second = makeEngine({ connector, storage });
      await second.engine.ensureRecovered();
      expect(second.store.getTurn(turnId)?.state).toBe("waiting");
      expect(second.recovered).toEqual([
        expect.objectContaining({ resolution: "waiting" })
      ]);
      expect(connector.runs).toHaveLength(1);

      // The completion is an ordinary inbound event joining the turn.
      const completion = await second.engine.submit({
        ...inbound("t1", "m2", "yes"),
        interaction: { id: "appr-1", value: "yes" }
      });
      expect(completion.kind).toBe("resumed");

      const turn = await second.engine.waitForSettlement(turnId);
      expect(turn.outcome).toBe("ok");
      // The re-entered run saw the completed interaction.
      expect(connector.runs[1]?.interactions).toEqual([
        {
          id: "appr-1",
          kind: "approval",
          payload: { action: "deploy" },
          value: "yes"
        }
      ]);
      // The continuation starts after the pre-pause journal.
      expect(turn.continuationFromSeq).toBeGreaterThan(0);
      expect(journalText(second.store.listChunks(turnId, 0))).toBe(
        "Deploy to prod?Deployed."
      );
    });
  });

  it("rejects a completion submitted from another conversation", async () => {
    await withStorage("chaos-waiting-conversation", async (storage) => {
      const connector = attemptConnector([
        // eslint-disable-next-line require-yield
        async function* () {
          throw new TurnPause({ id: "appr-1", kind: "approval" });
        },
        () => textPart("p2", "done")
      ]);
      const { engine } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("private", "m1", "go"));
      await until(
        () => engine.getTurn(admission.turn!.id)?.state === "waiting",
        "waiting state"
      );

      const foreignCompletion = await engine.submit({
        ...inbound("public", "m2", "yes"),
        interaction: { id: "appr-1", value: "yes" }
      });

      expect(foreignCompletion.kind).toBe("absorbed");
      expect(engine.getTurn(admission.turn!.id)?.state).toBe("waiting");
      expect(connector.runs).toHaveLength(1);
    });
  });

  it("absorbs a duplicate interaction completion", async () => {
    await withStorage("chaos-waiting-double-tap", async (storage) => {
      const connector = attemptConnector([
        // eslint-disable-next-line require-yield
        async function* () {
          throw new TurnPause({ id: "appr-1", kind: "approval" });
        },
        () => textPart("p2", "done")
      ]);
      const { engine } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "go"));
      await until(
        () => engine.getTurn(admission.turn!.id)?.state === "waiting",
        "waiting state"
      );

      const tap = await engine.submit({
        ...inbound("t1", "m2", "yes"),
        interaction: { id: "appr-1", value: "yes" }
      });
      expect(tap.kind).toBe("resumed");
      await engine.waitForSettlement(admission.turn!.id);

      const doubleTap = await engine.submit({
        ...inbound("t1", "m3", "yes"),
        interaction: { id: "appr-1", value: "yes" }
      });
      expect(doubleTap.kind).toBe("absorbed");
      expect(connector.runs).toHaveLength(2);
    });
  });
});

describe("kill at SETTLED", () => {
  it("treats any retry as a no-op", async () => {
    await withStorage("chaos-settled", async (storage) => {
      const connector = attemptConnector([() => textPart("p1", "answer")]);
      const first = makeEngine({ connector, storage });
      const admission = await first.engine.submit(inbound("t1", "m1", "hi"));
      await first.engine.waitForSettlement(admission.turn!.id);

      const second = makeEngine({ connector, storage });
      const retry = await second.engine.submit(inbound("t1", "m1", "hi"));

      expect(retry.kind).toBe("absorbed");
      expect(connector.runs).toHaveLength(1);
      expect(journalText(second.store.listChunks(admission.turn!.id, 0))).toBe(
        "answer"
      );
    });
  });
});

describe("turn serialization", () => {
  it("runs one conversation's turns strictly one at a time, in order", async () => {
    await withStorage("serial-conversation", async (storage) => {
      const order: string[] = [];
      const gate = new Gate();
      const connector = attemptConnector([
        async function* (turn) {
          const id = turn.input[0]!.id;
          order.push(id);
          if (id === "m1") {
            await gate.passed;
          }
          yield* textPart(`p-${id}`, `answer to ${id}`);
        }
      ]);
      const { engine } = makeEngine({ connector, storage });

      const first = await engine.submit(inbound("t1", "m1", "one"));
      const second = await engine.submit(inbound("t1", "m2", "two"));
      const other = await engine.submit(inbound("t-other", "m3", "three"));

      // A different conversation settles while t1's first turn is parked —
      // and t1's second turn has not been allowed to start.
      await engine.waitForSettlement(other.turn!.id);
      expect(order).toEqual(["m1", "m3"]);

      gate.open();
      await engine.waitForSettlement(first.turn!.id);
      const settled = await engine.waitForSettlement(second.turn!.id);

      expect(order).toEqual(["m1", "m3", "m2"]);
      expect(settled.outcome).toBe("ok");
    });
  });
});

describe("WAITING conversation concurrency", () => {
  it("lets later turns run and gives the resumed turn the latest conversation state", async () => {
    await withStorage("waiting-background-progress", async (storage) => {
      const order: string[] = [];
      const connector: AgentConnector = {
        async *run(turn) {
          const messageId = turn.input[0]!.id;
          order.push(messageId);
          if (messageId === "m1" && turn.interactions.length === 0) {
            turn.state.set("latest", "before-approval");
            throw new TurnPause({ id: "approval", kind: "approval" });
          }
          if (messageId === "m2") {
            turn.state.set("latest", "newer-turn");
            yield* textPart("p2", "second done");
            return;
          }
          expect(turn.state.get("latest")).toBe("newer-turn");
          yield* textPart("p1", "first resumed");
        }
      };
      const { engine } = makeEngine({ connector, storage });

      const first = await engine.submit(inbound("t1", "m1", "one"));
      await until(
        () => engine.getTurn(first.turn!.id)?.state === "waiting",
        "first turn waiting"
      );
      const second = await engine.submit(inbound("t1", "m2", "two"));
      await engine.waitForSettlement(second.turn!.id);

      expect(engine.getTurn(first.turn!.id)?.state).toBe("waiting");
      expect(order).toEqual(["m1", "m2"]);

      await engine.submit({
        ...inbound("t1", "m3", "approved"),
        interaction: { id: "approval", value: true }
      });
      await engine.waitForSettlement(first.turn!.id);
      expect(order).toEqual(["m1", "m2", "m1"]);
    });
  });
});

describe("cancellation", () => {
  it("cancels a streaming turn even when the connector ignores its signal", async () => {
    await withStorage("cancel-streaming", async (storage) => {
      const park = new Gate();
      const connector = attemptConnector([
        // Never reads turn.signal — the engine must still stop it.
        () => parkAfter(textPart("p1", "half an ans"), park)
      ]);
      const { engine, store } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(
        () => store.getTurn(turnId)?.state === "streaming",
        "streaming state"
      );

      const turn = await engine.cancelTurn(turnId, "user pressed stop");
      expect(turn?.outcome).toBe("interrupted");
      expect(turn?.errorText).toBe("user pressed stop");
      // The partial stays and the journal is closed for replay.
      const journal = store.listChunks(turnId, 0);
      expect(journalText(journal)).toBe("half an ans");
      expect(journal.at(-1)?.chunk.type).toBe("text-end");
    });
  });

  it("hands the abort signal to connectors that honor it", async () => {
    await withStorage("cancel-signal", async (storage) => {
      let sawAbort = false;
      const connector = attemptConnector([
        async function* (turn) {
          // Real connectors register their abort handling up front.
          const seen = new Promise<void>((resolve) => {
            const notice = () => {
              sawAbort = true;
              resolve();
            };
            if (turn.signal.aborted) {
              notice();
              return;
            }
            turn.signal.addEventListener("abort", notice, { once: true });
          });
          yield* textPart("p1", "working");
          await seen;
          throw new Error("connector noticed the abort");
        }
      ]);
      const { engine, store } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(
        () => store.getTurn(turnId)?.state === "streaming",
        "streaming state"
      );
      const turn = await engine.cancelTurn(turnId);

      expect(turn?.outcome).toBe("interrupted");
      await until(() => sawAbort, "the connector to observe the abort");
    });
  });

  it("cancels a durable wait — the abandoned approval settles interrupted", async () => {
    await withStorage("cancel-waiting", async (storage) => {
      const connector = attemptConnector([
        async function* () {
          yield* textPart("q1", "Approve?");
          throw new TurnPause({ id: "appr-1", kind: "approval" });
        }
      ]);
      const { engine } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(
        () => engine.getTurn(turnId)?.state === "waiting",
        "waiting state"
      );

      const turn = await engine.cancelTurn(turnId, "approval abandoned");
      expect(turn?.state).toBe("settled");
      expect(turn?.outcome).toBe("interrupted");
      // A completion arriving after the cancel absorbs like any stale tap.
      const late = await engine.submit({
        ...inbound("t1", "m2", "yes"),
        interaction: { id: "appr-1", value: "yes" }
      });
      expect(late.kind).toBe("absorbed");
    });
  });
});

describe("interaction id reuse", () => {
  it("re-opens the interaction instead of wedging the turn", async () => {
    await withStorage("interaction-reuse", async (storage) => {
      const connector = attemptConnector([
        async function* () {
          yield* textPart("q1", "First ask. ");
          throw new TurnPause({ id: "stable-id", kind: "approval" });
        },
        // The re-entered run asks again with the SAME id.
        async function* (turn) {
          if (turn.interactions.at(-1)?.value === "again") {
            throw new TurnPause({ id: "stable-id", kind: "approval" });
          }
          yield* textPart("p2", "Done.");
        },
        () => textPart("p3", "Finally done.")
      ]);
      const { engine } = makeEngine({ connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "go"));
      const turnId = admission.turn!.id;
      await until(
        () => engine.getTurn(turnId)?.state === "waiting",
        "first wait"
      );

      await engine.submit({
        ...inbound("t1", "m2", "again"),
        interaction: { id: "stable-id", value: "again" }
      });
      await until(
        () =>
          engine.getTurn(turnId)?.state === "waiting" &&
          connector.runs.length === 2,
        "second wait on the same id"
      );

      await engine.submit({
        ...inbound("t1", "m3", "yes"),
        interaction: { id: "stable-id", value: "yes" }
      });
      const turn = await engine.waitForSettlement(turnId);
      expect(turn.outcome).toBe("ok");
      expect(connector.runs).toHaveLength(3);
    });
  });
});

describe("retention", () => {
  it("prunes settled journals after 24h but keeps the ledger row for dedupe", async () => {
    await withStorage("chaos-retention", async (storage) => {
      const clock = new FakeClock();
      const connector = attemptConnector([() => textPart("p1", "old news")]);
      const { engine, store } = makeEngine({ clock, connector, storage });

      const admission = await engine.submit(inbound("t1", "m1", "hi"));
      const turn = await engine.waitForSettlement(admission.turn!.id);

      clock.advance(JOURNAL_RETENTION_MS + 60_000);
      await engine.onWake();

      expect(store.listChunks(turn.id, 0)).toHaveLength(0);
      expect(store.getTurn(turn.id)?.state).toBe("settled");
      const retry = await engine.submit(inbound("t1", "m1", "hi"));
      expect(retry.kind).toBe("absorbed");
    });
  });
});
