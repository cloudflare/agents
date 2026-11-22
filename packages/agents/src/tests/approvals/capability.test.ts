import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { stableHash } from "../../approvals";
import {
  backdateDecisionJob,
  type ApprovalsHarnessObject
} from "../capabilities/approvals";

/**
 * Capability-level Approvals tests: the capability installed on a minimal
 * real Durable Object through a real Lifecycle over real SQLite. A reset is
 * a fresh test step whose in-memory state never saw the work: the rows say
 * where it was, and the recovery job runs from there.
 */

function harness() {
  return env.ApprovalsHarnessObject.getByName(crypto.randomUUID());
}

describe("Approvals effect ledger", () => {
  it("runs an effect once and replays its recorded JSON value", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        let runs = 0;
        const when = new Date(0);
        const call = () =>
          instance.approvals.once({
            key: "order-1",
            name: "charge",
            input: { amount: 5, currency: "usd" },
            run: () => {
              runs += 1;
              return { when };
            }
          });
        const first = await call();
        expect(first).toEqual({
          status: "ran",
          value: { when: when.toISOString() }
        });
        const second = await call();
        expect(second).toEqual({
          status: "replayed",
          value: { when: when.toISOString() }
        });
        expect(runs).toBe(1);
        expect(instance.approvals.effect("order-1")).toMatchObject({
          status: "settled",
          name: "charge",
          value: { when: when.toISOString() }
        });
      }
    );
  });

  it("matches input by value, whatever the key order", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        await instance.approvals.once({
          key: "k",
          name: "n",
          input: { a: 1, b: 2 },
          run: () => "x"
        });
        const again = await instance.approvals.once({
          key: "k",
          name: "n",
          input: { b: 2, a: 1 },
          run: () => "y"
        });
        expect(again).toEqual({ status: "replayed", value: "x" });
      }
    );
  });

  it("answers conflict for the same key with another input or name", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        await instance.approvals.once({
          key: "k",
          name: "n",
          input: 1,
          run: () => "x"
        });
        let runs = 0;
        const run = () => {
          runs += 1;
          return "y";
        };
        expect(
          await instance.approvals.once({ key: "k", name: "n", input: 2, run })
        ).toEqual({ status: "conflict" });
        expect(
          await instance.approvals.once({ key: "k", name: "m", input: 1, run })
        ).toEqual({ status: "conflict" });
        expect(runs).toBe(0);
      }
    );
  });

  it("releases the claim when the effect throws, so a later call runs", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        await expect(
          instance.approvals.once({
            key: "k",
            name: "n",
            input: null,
            run: () => {
              throw new Error("down");
            }
          })
        ).rejects.toThrow("down");
        expect(instance.approvals.effect("k")).toBeUndefined();
        expect(
          await instance.approvals.once({
            key: "k",
            name: "n",
            input: null,
            run: () => "ok"
          })
        ).toEqual({ status: "ran", value: "ok" });
      }
    );
  });

  it("shares one run between callers in the same isolate", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        let runs = 0;
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const call = () =>
          instance.approvals.once({
            key: "k",
            name: "n",
            input: null,
            run: async () => {
              runs += 1;
              await gate;
              return runs;
            }
          });
        const a = call();
        const b = call();
        finish();
        expect(await a).toEqual({ status: "ran", value: 1 });
        expect(await b).toEqual({ status: "ran", value: 1 });
        expect(runs).toBe(1);
      }
    );
  });

  it("answers conflict, not the running value, for the same key with another input", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const first = instance.approvals.once({
          key: "refund:o1",
          name: "refund",
          input: { amount: 40 },
          run: async () => {
            await gate;
            return "refunded 40";
          }
        });
        const second = await instance.approvals.once({
          key: "refund:o1",
          name: "refund",
          input: { amount: 60 },
          run: () => "refunded 60"
        });
        expect(second).toEqual({ status: "conflict" });
        finish();
        expect(await first).toEqual({ status: "ran", value: "refunded 40" });
      }
    );
  });

  it("keeps a running claim through a sweep, however old", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject, state) => {
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const running = instance.approvals.once({
          key: "slow",
          name: "n",
          input: null,
          run: async () => {
            await gate;
            return "done";
          }
        });
        state.storage.sql.exec(
          "UPDATE cf_agents_effects SET updated_at = ? WHERE key = 'slow'",
          Date.now() - 10_000
        );
        instance.retention = { effectPendingMs: 1000 };
        expect(await instance.approvals.sweep({ force: true })).toMatchObject({
          effects: 0,
          decisions: 0
        });
        finish();
        expect(await running).toEqual({ status: "ran", value: "done" });
        expect(instance.approvals.effect("slow")?.status).toBe("settled");
      }
    );
  });

  it("tells two dates apart in an input", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        await instance.approvals.once({
          key: "invoice-1",
          name: "remind",
          input: { due: new Date("2026-03-01T00:00:00Z") },
          run: () => "march"
        });
        expect(
          await instance.approvals.once({
            key: "invoice-1",
            name: "remind",
            input: { due: new Date("2026-04-01T00:00:00Z") },
            run: () => "april"
          })
        ).toEqual({ status: "conflict" });
      }
    );
  });

  it("answers in-doubt for a claim an ended attempt left, and reclaims it only when allowed", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject, state) => {
        // An attempt in an earlier isolate claimed the key and never
        // finished: the row is pending and nothing here is running it.
        const old = Date.now() - 10 * 60 * 1000;
        instance.approvals.importRecords({
          effects: [
            {
              key: "k",
              name: "n",
              inputHash: stableHash({ id: 1 }),
              status: "pending",
              resultJson: null,
              createdAt: old,
              updatedAt: old
            }
          ]
        });
        let runs = 0;
        const run = () => {
          runs += 1;
          return "again";
        };
        const doubt = await instance.approvals.once({
          key: "k",
          name: "n",
          input: { id: 1 },
          run
        });
        expect(doubt.status).toBe("in-doubt");
        expect(runs).toBe(0);

        const tooFresh = await instance.approvals.once({
          key: "k",
          name: "n",
          input: { id: 1 },
          run,
          reclaimAfterMs: 60 * 60 * 1000
        });
        expect(tooFresh.status).toBe("in-doubt");

        const reclaimed = await instance.approvals.once({
          key: "k",
          name: "n",
          input: { id: 1 },
          run,
          reclaimAfterMs: 5 * 60 * 1000
        });
        expect(reclaimed).toMatchObject({
          status: "reclaimed",
          value: "again"
        });
        expect(runs).toBe(1);
        const rows = [
          ...state.storage.sql.exec(
            "SELECT status FROM cf_agents_effects WHERE key = 'k'"
          )
        ];
        expect(rows).toEqual([{ status: "settled" }]);
      }
    );
  });

  it("does not record a value that is not JSON, and runs it again next time", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const value = { n: BigInt(1) };
        const first = await instance.approvals.once({
          key: "k",
          name: "n",
          input: null,
          run: () => value
        });
        expect(first).toEqual({ status: "unrecorded", value });
        expect(instance.approvals.effect("k")).toBeUndefined();
      }
    );
  });

  it("replays a row in the encoding Think's action ledger wrote", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        instance.approvals.importRecords({
          effects: [
            {
              key: "action:send:order-9",
              name: "send",
              inputHash: stableHash({ to: "a@b.c" }),
              status: "settled",
              resultJson: JSON.stringify({
                valuePresent: true,
                value: { sent: 1 }
              }),
              createdAt: 1,
              updatedAt: 1
            }
          ]
        });
        expect(
          await instance.approvals.once({
            key: "action:send:order-9",
            name: "send",
            input: { to: "a@b.c" },
            run: () => ({ sent: 2 })
          })
        ).toEqual({ status: "replayed", value: { sent: 1 } });
      }
    );
  });
});

describe("Approvals decisions", () => {
  it("parks, lists, decides once and records the outcome", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const parked = instance.approvals.park({
          kind: "action",
          subject: { to: "a@b.c" },
          descriptor: { summary: "Send an email" }
        });
        expect(parked.id).toMatch(/^decision_/);
        expect(parked.status).toBe("pending");
        expect(instance.approvals.pending().map((d) => d.id)).toEqual([
          parked.id
        ]);

        const result = await instance.approvals.decide(parked.id, {
          approved: true
        });
        expect(result.status).toBe("settled");
        if (result.status !== "settled") return;
        expect(result.decision).toMatchObject({
          status: "settled",
          verdict: { approved: true },
          outcome: { status: "done", effect: "ran" },
          acknowledged: true
        });
        expect(instance.continued).toEqual([parked.id]);
        expect(instance.handedOff).toEqual([
          { id: parked.id, redelivered: false }
        ]);
        expect(instance.approvals.pending()).toEqual([]);

        // A second tab, or a retry: the decision is taken, and the record
        // says what came of it.
        const again = await instance.approvals.decide(parked.id, {
          approved: false,
          reason: "late"
        });
        expect(again).toMatchObject({
          status: "already-decided",
          decision: {
            verdict: { approved: true },
            outcome: { status: "done", effect: "ran" }
          }
        });
        expect(instance.continued).toHaveLength(1);
        expect(instance.sideEffects).toBe(1);

        expect(
          await instance.approvals.decide("nope", { approved: true })
        ).toEqual({ status: "not-found" });
      }
    );
  });

  it("lets only one of two concurrent verdicts through", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        const [a, b] = await Promise.all([
          instance.approvals.decide(id, { approved: true }),
          instance.approvals.decide(id, { approved: false })
        ]);
        expect([a.status, b.status].sort()).toEqual([
          "already-decided",
          "settled"
        ]);
        expect(instance.continued).toEqual([id]);
      }
    );
  });

  it("carries a rejection's reason to the continuation", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        const result = await instance.approvals.decide(id, {
          approved: false,
          reason: "too risky"
        });
        expect(result).toMatchObject({
          status: "settled",
          decision: { outcome: { status: "rejected", reason: "too risky" } }
        });
        expect(instance.sideEffects).toBe(0);
      }
    );
  });

  it("settles with an error when the outcome is too large to store", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        instance.nextOutcome = { report: "x".repeat(2_500_000) };
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        const result = await instance.approvals.decide(id, { approved: true });
        expect(result.status).toBe("settled");
        if (result.status !== "settled") return;
        expect(result.decision.outcome).toBeUndefined();
        expect(result.decision.error).toMatch(/could not be stored/);
        expect(instance.continued).toEqual([id]);
      }
    );
  });

  it("records a decision made elsewhere and hands its outcome off", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const decision = await instance.approvals.record({
          id: "made-elsewhere",
          kind: "codemode",
          subject: { executionId: "e1" },
          verdict: { approved: true },
          outcome: { status: "completed" }
        });
        expect(decision).toMatchObject({
          status: "settled",
          outcome: { status: "completed" },
          acknowledged: true
        });
        expect(instance.continued).toEqual([]);
        expect(instance.handedOff).toEqual([
          { id: "made-elsewhere", redelivered: false }
        ]);
      }
    );
  });

  it("returns the existing record when the same id is parked again, and refuses another subject", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const first = instance.approvals.park({
          id: "p1",
          kind: "action",
          subject: { a: 1 }
        });
        const again = instance.approvals.park({
          id: "p1",
          kind: "action",
          subject: { a: 1 }
        });
        expect(again).toEqual(first);
        const reordered = instance.approvals.park({
          id: "p2",
          kind: "action",
          subject: { x: { b: 2, a: 1 } }
        });
        expect(
          instance.approvals.park({
            id: "p2",
            kind: "action",
            subject: { x: { a: 1, b: 2 } }
          })
        ).toEqual(reordered);
        expect(() =>
          instance.approvals.park({
            id: "p1",
            kind: "action",
            subject: { a: 2 }
          })
        ).toThrow(/another kind or subject/);
      }
    );
  });

  it("runs a decided continuation again after a reset, without repeating a recorded effect", async () => {
    const stub = harness();
    const id = await runInDurableObject(
      stub,
      async (instance: ApprovalsHarnessObject, state) => {
        await instance.lifecycle.start();
        const { id } = instance.approvals.park({
          kind: "action",
          subject: { to: "a@b.c" }
        });
        // The isolate that decided it ran the effect, then ended before the
        // outcome was written: the row is decided, the effect recorded.
        state.storage.sql.exec(
          `UPDATE cf_agents_decisions
           SET status = 'decided', verdict_json = ?, decided_at = ?
           WHERE id = ?`,
          JSON.stringify({ approved: true }),
          Date.now(),
          id
        );
        await instance.approvals.once({
          key: `effect:${id}`,
          name: "send",
          input: { to: "a@b.c" },
          run: () => ({ sent: true })
        });
        return id;
      }
    );

    // The next start finds the unfinished decision and makes its job due.
    await runInDurableObject(stub, async (instance: ApprovalsHarnessObject) => {
      await instance.approvals.onStart();
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: ApprovalsHarnessObject) => {
      // The continuation may still be finishing on the alarm's isolate.
      const settled = await instance.approvals.wait(id, { timeoutMs: 5000 });
      expect(settled).toMatchObject({
        status: "settled",
        outcome: { status: "done", effect: "replayed" },
        acknowledged: true
      });
      expect(instance.sideEffects).toBe(0);
    });
  });

  it("retries a failing continuation from its job, then settles with the error", async () => {
    const stub = harness();
    const id = await runInDurableObject(
      stub,
      async (instance: ApprovalsHarnessObject) => {
        await instance.lifecycle.start();
        instance.failuresBeforeSuccess = 10;
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        await expect(
          instance.approvals.decide(id, { approved: true })
        ).rejects.toThrow("continuation failed");
        expect(instance.approvals.get(id)?.status).toBe("decided");
        return id;
      }
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await runInDurableObject(
        stub,
        (_instance: ApprovalsHarnessObject, state) => {
          backdateDecisionJob(state.storage, id);
        }
      );
      await runDurableObjectAlarm(stub);
    }
    await runInDurableObject(stub, async (instance: ApprovalsHarnessObject) => {
      const settled = await instance.approvals.wait(id, { timeoutMs: 5000 });
      expect(settled).toMatchObject({
        status: "settled",
        error: "continuation failed"
      });
      expect(instance.continued).toEqual([id, id, id]);
    });
  });

  it("hands an outcome off again after a reset until it is acknowledged", async () => {
    const stub = harness();
    const id = await runInDurableObject(
      stub,
      async (instance: ApprovalsHarnessObject) => {
        await instance.lifecycle.start();
        instance.acknowledgeOnSettle = false;
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        await instance.approvals.decide(id, { approved: true });
        expect(instance.approvals.unacknowledged().map((d) => d.id)).toEqual([
          id
        ]);
        return id;
      }
    );
    await runInDurableObject(stub, async (instance: ApprovalsHarnessObject) => {
      instance.acknowledgeOnSettle = true;
      await instance.approvals.onStart();
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: ApprovalsHarnessObject) => {
      expect(instance.handedOff).toEqual([
        { id, redelivered: false },
        { id, redelivered: true }
      ]);
      expect(instance.approvals.unacknowledged()).toEqual([]);
      expect(instance.continued).toEqual([id]);
    });
  });

  it("wakes a waiter when the decision settles", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject) => {
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        const waiting = instance.approvals.wait(id);
        await expect(
          instance.approvals.wait(id, { timeoutMs: 1 })
        ).rejects.toThrow(/did not settle/);
        await instance.approvals.decide(id, { approved: true });
        expect((await waiting).status).toBe("settled");
        // Settled already: resolves at once.
        expect((await instance.approvals.wait(id)).status).toBe("settled");
        await expect(instance.approvals.wait("nope")).rejects.toThrow(
          /no decision/
        );
      }
    );
  });

  it("fails a waiter when its decision expires", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject, state) => {
        const { id } = instance.approvals.park({ kind: "action", subject: 1 });
        const waiting = instance.approvals.wait(id);
        state.storage.sql.exec(
          "UPDATE cf_agents_decisions SET created_at = ? WHERE id = ?",
          Date.now() - 10_000,
          id
        );
        instance.retention = { decisionPendingMs: 1000 };
        await instance.approvals.sweep({ force: true });
        await expect(waiting).rejects.toThrow(/expired/);
      }
    );
  });

  it("finishes a continuation a real reset cut off", async () => {
    const name = crypto.randomUUID();
    let stub = env.ApprovalsHarnessObject.getByName(name);
    const id = await stub.decideHeld();
    await stub.restart().catch(() => {});

    stub = env.ApprovalsHarnessObject.getByName(name);
    expect(await stub.status(id)).toBe("decided");
    await runInDurableObject(stub, (_instance, state) => {
      backdateDecisionJob(state.storage, id);
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: ApprovalsHarnessObject) => {
      const settled = await instance.approvals.wait(id, { timeoutMs: 5000 });
      expect(settled).toMatchObject({
        status: "settled",
        outcome: { status: "done", effect: "ran" }
      });
      expect(instance.continued).toEqual([id]);
      expect(instance.sideEffects).toBe(1);
    });
  });

  it("sweeps expired rows per retention, and never a decided one", async () => {
    await runInDurableObject(
      harness(),
      async (instance: ApprovalsHarnessObject, state) => {
        const old = Date.now() - 10_000;
        instance.approvals.importRecords({
          effects: [
            {
              key: "old-settled",
              name: "n",
              inputHash: "h",
              status: "settled",
              resultJson: null,
              createdAt: old,
              updatedAt: old
            },
            {
              key: "old-pending",
              name: "n",
              inputHash: "h",
              status: "pending",
              resultJson: null,
              createdAt: old,
              updatedAt: old
            }
          ],
          decisions: [
            {
              id: "old-pending",
              kind: "a",
              subject: 1,
              status: "pending",
              createdAt: old
            }
          ]
        });
        instance.approvals.park({ id: "fresh", kind: "a", subject: 1 });
        instance.approvals.park({ id: "decided", kind: "a", subject: 1 });
        state.storage.sql.exec(
          "UPDATE cf_agents_decisions SET status = 'decided', created_at = ? WHERE id = 'decided'",
          old
        );
        instance.retention = {
          effectSettledMs: 1000,
          effectPendingMs: false,
          decisionPendingMs: 1000
        };
        const swept = await instance.approvals.sweep({ force: true });
        expect(swept).toEqual({
          effects: 1,
          decisions: 1,
          settledEffects: 1,
          pendingEffects: 0,
          pendingDecisions: 1,
          settledDecisions: 0
        });
        expect(instance.approvals.effect("old-settled")).toBeUndefined();
        expect(instance.approvals.effect("old-pending")).toBeDefined();
        expect(instance.approvals.get("old-pending")).toBeUndefined();
        expect(instance.approvals.get("fresh")).toBeDefined();
        expect(instance.approvals.get("decided")).toBeDefined();

        // Throttled: a second sweep within the hour does nothing.
        expect(await instance.approvals.sweep()).toMatchObject({
          effects: 0,
          decisions: 0
        });
      }
    );
  });
});
