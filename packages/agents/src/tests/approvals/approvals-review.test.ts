import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { backdateDecisionJob } from "../capabilities/approvals";
import { describe, expect, it } from "vitest";
import type { ApprovalsReviewObject } from "../capabilities/approvals-review-harness";

/** Contract edges of Approvals found in review. */
function stub() {
  return env.ApprovalsReviewObject.getByName(crypto.randomUUID());
}

describe("Approvals contract edges", () => {
  it("1. a concurrent call with the same key and another input is a conflict, not the first call's value", async () => {
    await runInDurableObject(stub(), async (i: ApprovalsReviewObject) => {
      let finish!: () => void;
      const gate = new Promise<void>((r) => (finish = r));
      const a = i.approvals.once({
        key: "k",
        name: "charge",
        input: { amount: 5 },
        run: async () => {
          await gate;
          return "charged 5";
        }
      });
      const b = i.approvals.once({
        key: "k",
        name: "refund",
        input: { amount: 500 },
        run: async () => "refunded 500"
      });
      finish();
      expect(await a).toEqual({ status: "ran", value: "charged 5" });
      expect(await b).toEqual({ status: "conflict" });
    });
  });

  it("2. an effect whose value is over the row limit does not throw as if run() failed, and does not wedge the key", async () => {
    await runInDurableObject(stub(), async (i: ApprovalsReviewObject) => {
      let runs = 0;
      const call = () =>
        i.approvals.once({
          key: "big",
          name: "n",
          input: null,
          run: () => {
            runs += 1;
            return "x".repeat(3 * 1024 * 1024);
          }
        });
      const first = await call().then(
        (o) => o.status,
        (e: unknown) => `threw: ${String(e).slice(0, 80)}`
      );
      expect(first).toBe("unrecorded");
      expect(runs).toBe(1);
    });
  });

  it("3. a continuation whose outcome cannot be stored settles with the error, not a retry loop", async () => {
    // A row SQLite will not store fails the same way on every run, so the
    // decision settles with the error at once instead of spending attempts.
    const s = stub();
    await runInDurableObject(s, async (i: ApprovalsReviewObject, state) => {
      await i.lifecycle.start();
      let runs = 0;
      i.decided = async () => {
        runs += 1;
        return "x".repeat(3 * 1024 * 1024);
      };
      const { id } = i.approvals.park({ kind: "k", subject: 1 });
      const result = await i.approvals.decide(id, { approved: true });
      expect(result.status).toBe("settled");
      expect(i.approvals.get(id)).toMatchObject({
        status: "settled",
        error: expect.stringMatching(/could not be stored/)
      });
      expect(runs).toBe(1);
      const jobs = [
        ...state.storage.sql.exec(
          "SELECT id FROM cf_agents_jobs WHERE capability = 'approvals'"
        )
      ];
      expect(jobs).toEqual([]);
    });
  });

  it("4. a hand-off that throws on the deciding call is handed off again without waiting for a restart", async () => {
    const s = stub();
    const id = await runInDurableObject(s, async (i: ApprovalsReviewObject) => {
      await i.lifecycle.start();
      let calls = 0;
      i.settled = async (d) => {
        calls += 1;
        if (calls === 1) throw new Error("transcript write failed");
        i.approvals.acknowledge(d.id);
      };
      const { id } = i.approvals.park({ kind: "k", subject: 1 });
      await i.approvals.decide(id, { approved: true }).catch(() => undefined);
      return id;
    });
    await runInDurableObject(s, (_i: ApprovalsReviewObject, state) => {
      const jobs = [
        ...state.storage.sql.exec(
          "SELECT id FROM cf_agents_jobs WHERE capability = 'approvals'"
        )
      ];
      // Something must still be due to retry the hand-off.
      expect(jobs.length).toBe(1);
      backdateDecisionJob(state.storage, id);
    });
    await runDurableObjectAlarm(s);
    await runInDurableObject(s, (i: ApprovalsReviewObject) => {
      expect(i.approvals.get(id)?.acknowledged).toBe(true);
    });
  });
});
