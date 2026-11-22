import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InboxHarnessObject } from "../capabilities/inbox";

/** Records an earlier store or an unstorable outcome leave behind. */
describe("Inbox edge records", () => {
  // A handler that throws ends `error` with no retry (types.ts, design doc).
  // When the settle write itself fails, the exception escapes
  // #end -> #step -> #drive's catch, the row stays `running`, and the
  // handler runs again on the next wake. A result JSON.stringify cannot
  // serialize takes that path; so does an error message or progress over
  // the 2 MB row limit in production (miniflare does not enforce it).
  // Needs fixture-bigint.patch.
  it("ends a request whose result cannot be stored, without running it again", async () => {
    const stub = env.InboxHarnessObject.getByName(crypto.randomUUID());
    const id = await runInDurableObject(
      stub,
      async (instance: InboxHarnessObject) => {
        const { request } = await instance.inbox.submit(
          "bigint" as "echo",
          null as never
        );
        const done = await instance.inbox.wait(request.id, {
          timeoutMs: 3_000
        });
        expect(instance.calls.length).toBe(1);
        expect(done?.status).toBe("error");
        return request.id;
      }
    );
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      await instance.inbox.wait(id, { timeoutMs: 3_000 });
      expect(instance.calls.length).toBe(0);
    });
  });

  // import() of a pending record that already had an attempt (Think's old
  // `running -> pending` reset leaves exactly that). #step calls
  // #execute(request, 1); #rows.start() guards on `attempt = 0`, fails,
  // #execute returns without awaiting anything, #drive reads the same row
  // again: a microtask loop that never yields to timers or I/O.
  it("runs an imported pending record that had an earlier attempt", async () => {
    const stub = env.InboxHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      await instance.inbox.import({
        id: "old",
        kind: "echo",
        status: "pending",
        attempt: 1,
        payload: { value: "x" },
        createdAt: Date.now()
      });
      const done = await instance.inbox.wait("old", { timeoutMs: 3_000 });
      expect(done?.status).toBe("completed");
    });
  }, 20_000);
});
