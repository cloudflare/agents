import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Inbox, type InboxRequest } from "../../inbox";
import { eventually, type InboxHarnessObject } from "../capabilities/inbox";

/** An error the runtime treats as a platform failure. */
function retryable(): Error {
  return Object.assign(new Error("retryable platform error"), {
    retryable: true
  });
}

function harness() {
  return env.InboxHarnessObject.getByName(crypto.randomUUID());
}

const count = (
  instance: InboxHarnessObject,
  id: string,
  status: string
): number =>
  instance.statuses.filter((s) => s.id === id && s.status === status).length;

describe("Inbox terminal reports and records", () => {
  it("keeps waiters waiting when a terminal report fails, and replays it", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        let failed = false;
        instance.reportHook = (r: InboxRequest) => {
          if (r.id === request.id && r.status === "completed" && !failed) {
            failed = true;
            throw retryable();
          }
        };
        let resolvedAfter = -1;
        const waiting = instance.inbox.wait(request.id).then((r) => {
          resolvedAfter = count(instance, request.id, "completed");
          return r;
        });
        instance.release();
        await eventually(() => failed);
        // The replay waits out a backoff after a failure; start it now.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await instance.inbox.onStart();
        expect(await waiting).toMatchObject({ status: "completed" });
        // Not after the failed report: after the replay that returned.
        expect(resolvedAfter).toBe(2);
        expect(instance.inbox.isSettled(request.id)).toBe(true);
      }
    );
  });

  it("replays only the record it read, not a later one under the same id", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const a = await instance.inbox.submit(
          "echo",
          { value: "a" },
          {
            id: "a",
            lane: "x"
          }
        );
        const b = await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            id: "b",
            lane: "x"
          }
        );
        await instance.inbox.wait(a.request.id);
        await instance.inbox.wait(b.request.id);
        instance.forgetReport("a");
        instance.forgetReport("b");
        instance.hold();
        let reused = false;
        instance.reportHook = async (r: InboxRequest) => {
          if (r.id === "a" && !reused) {
            reused = true;
            instance.inbox.delete("b");
            await instance.inbox.submit(
              "echo",
              { value: "new b" },
              {
                id: "b",
                lane: "y"
              }
            );
          }
        };
        await instance.inbox.onStart();
        await eventually(() => reused && instance.inbox.isSettled("a"));
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The new b was reported once, as pending, by its own submit.
        expect(count(instance, "b", "pending")).toBe(2);
        expect(instance.inbox.isSettled("b")).toBe(false);
        instance.release();
        expect(await instance.inbox.wait("b")).toMatchObject({
          status: "completed",
          result: { echoed: "new b" }
        });
      }
    );
  });

  it("waits out a backoff before replaying a report that failed", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        let failed = false;
        instance.reportHook = (r: InboxRequest) => {
          if (r.status === "completed" && !failed) {
            failed = true;
            throw retryable();
          }
        };
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        await eventually(() => failed);
        const reportJob = () =>
          state.storage.sql
            .exec(
              "SELECT time FROM cf_agents_jobs WHERE capability = 'inbox' AND fn = 'report'"
            )
            .toArray();
        await eventually(() => reportJob().length === 1);
        expect(reportJob()[0].time as number).toBeGreaterThan(
          Date.now() + 20_000
        );
        expect(instance.inbox.isSettled(request.id)).toBe(false);
      }
    );
  });

  it("answers the waiters of a record deleted while its report failed", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        instance.reportHook = (r: InboxRequest) => {
          if (r.id === request.id && r.status === "completed") {
            instance.inbox.delete(request.id);
            throw retryable();
          }
        };
        const waiting = instance.inbox.wait(request.id, { timeoutMs: 3_000 });
        instance.release();
        expect(await waiting).toMatchObject({
          status: "completed",
          result: { echoed: "a" }
        });
      }
    );
  });

  it("serializes a reused settlement for each request it ends", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const one = await instance.inbox.submit(
          "settle",
          { as: "detached" },
          {
            lane: "one"
          }
        );
        const two = await instance.inbox.submit(
          "settle",
          { as: "detached" },
          {
            lane: "two"
          }
        );
        await eventually(
          () =>
            instance.inbox.get(one.request.id)?.detached === true &&
            instance.inbox.get(two.request.id)?.detached === true
        );
        const result = { n: 1 };
        const outcome = Inbox.completed(result);
        await instance.inbox.settle(one.request.id, outcome);
        result.n = 2;
        await instance.inbox.settle(two.request.id, outcome);
        expect(instance.inbox.get(one.request.id)?.result).toEqual({ n: 1 });
        expect(instance.inbox.get(two.request.id)?.result).toEqual({ n: 2 });
      }
    );
  });

  it("reads a survivor's merged ids written before they carried their order", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        await eventually(() => instance.running.has(a.request.id));
        const s = await instance.inbox.submit("echo", { value: "s" });
        state.storage.sql.exec(
          "UPDATE cf_agents_inbox SET merged = ? WHERE id = ?",
          JSON.stringify(["x", "y"]),
          s.request.id
        );
        instance.release();
        await instance.inbox.wait(s.request.id);
        expect(
          instance.calls.find((call) => call.id === s.request.id)?.merged
        ).toEqual(["x", "y"]);
      }
    );
  });

  it("reports the rest of a clear when one of its reports fails", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        const b = await instance.inbox.submit("echo", { value: "b" });
        await eventually(() => instance.running.has(a.request.id));
        let failed = false;
        instance.reportHook = (r: InboxRequest) => {
          if (r.id === a.request.id && r.status === "skipped" && !failed) {
            failed = true;
            throw retryable();
          }
        };
        await expect(instance.inbox.clear("echo")).rejects.toThrow(/retryable/);
        instance.release();
        // The replay waits out a backoff after a failure; start it now.
        await instance.inbox.onStart();
        expect(
          await instance.inbox.wait(b.request.id, { timeoutMs: 3_000 })
        ).toMatchObject({ status: "skipped" });
        await eventually(() => instance.inbox.isSettled(b.request.id));
        await eventually(() => instance.inbox.isSettled(a.request.id));
      }
    );
  });

  it("keeps the report job while the replay runs", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        const { request } = await instance.inbox.submit("echo", { value: "a" });
        await instance.inbox.wait(request.id);
        instance.forgetReport(request.id);
        let entered = false;
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        instance.reportHook = async () => {
          entered = true;
          await gate;
        };
        const jobs = () =>
          state.storage.sql
            .exec(
              "SELECT COUNT(*) AS n FROM cf_agents_jobs WHERE capability = 'inbox' AND fn = 'report'"
            )
            .one().n;
        await instance.inbox.onStart();
        await eventually(() => entered);
        expect(jobs()).toBe(1);
        finish();
        await eventually(() => instance.inbox.isSettled(request.id));
        await eventually(() => jobs() === 0);
      }
    );
  });

  it("looks records up by their token through an index", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject, state) => {
        await instance.inbox.submit("echo", { value: "a" });
        const indexes = state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'cf_agents_inbox_token_idx'"
          )
          .toArray();
        expect(indexes).toHaveLength(1);
      }
    );
  });

  it("names the superseded requests in arrival order when the survivor changes", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        instance.hold();
        const a = await instance.inbox.submit("echo", { value: "a" });
        await eventually(() => instance.running.has(a.request.id));
        const b = await instance.inbox.submit(
          "echo",
          { value: "b" },
          {
            policy: "merge"
          }
        );
        const c = await instance.inbox.submit(
          "echo",
          { value: "c" },
          {
            policy: "merge"
          }
        );
        const d = await instance.inbox.submit(
          "echo",
          { value: "d" },
          {
            policy: "merge"
          }
        );
        let e: string | undefined;
        instance.reportHook = async (r: InboxRequest) => {
          if (r.id === b.request.id && r.status === "skipped" && !e) {
            e = (
              await instance.inbox.submit(
                "echo",
                { value: "e" },
                {
                  policy: "merge"
                }
              )
            ).request.id;
          }
        };
        instance.release();
        await eventually(() => e !== undefined);
        await instance.inbox.wait(e!);
        const survivor = instance.calls.find((call) => call.id === e);
        expect(survivor?.merged).toEqual([
          b.request.id,
          c.request.id,
          d.request.id
        ]);
      }
    );
  });

  it("runs a request whose isolate died during its first pending report", async () => {
    const stub = harness();
    const id = await runInDurableObject(
      stub,
      async (instance: InboxHarnessObject) => {
        instance.slowPending = 1_000;
        const id = crypto.randomUUID();
        void instance.inbox
          .submit("echo", { value: "a" }, { id })
          .catch(() => {});
        await eventually(() => instance.statuses.some((s) => s.id === id));
        return id;
      }
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      expect(await instance.inbox.wait(id, { timeoutMs: 5_000 })).toMatchObject(
        { status: "completed" }
      );
    });
  });

  it("stores the result it serialized, once", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const { request } = await instance.inbox.submit("once", null);
        expect(await instance.inbox.wait(request.id)).toMatchObject({
          status: "completed",
          result: { value: "first" }
        });
      }
    );
  });

  it("ends an imported pending record whose attempts are spent, without running it", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        await instance.inbox.import({
          id: "spent",
          kind: "echo",
          status: "pending",
          attempt: 2,
          payload: { value: "x" },
          createdAt: Date.now()
        });
        await instance.inbox.import({
          id: "left",
          kind: "echo",
          status: "pending",
          attempt: 1,
          payload: { value: "y" },
          createdAt: Date.now()
        });
        expect(await instance.inbox.wait("spent")).toMatchObject({
          status: "error",
          error: "Interrupted 2 times"
        });
        expect(await instance.inbox.wait("left")).toMatchObject({
          status: "completed",
          attempt: 2
        });
        expect(instance.calls.map((call) => call.id)).toEqual(["left"]);
      }
    );
  });

  it("ends a detached request whose settled result cannot be stored", async () => {
    await runInDurableObject(
      harness(),
      async (instance: InboxHarnessObject) => {
        const { request } = await instance.inbox.submit("settle", {
          as: "detached"
        });
        await eventually(
          () => instance.inbox.get(request.id)?.detached === true
        );
        expect(
          await instance.inbox.settle(
            request.id,
            Inbox.completed({ n: BigInt(1) })
          )
        ).toBe(true);
        expect(instance.inbox.get(request.id)).toMatchObject({
          status: "error",
          error: expect.stringMatching(/could not be stored/)
        });
      }
    );
  });
});
