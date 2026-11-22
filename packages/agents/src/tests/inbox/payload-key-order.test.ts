import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InboxHarnessObject } from "../capabilities/inbox";

describe("Inbox idempotent submit", () => {
  it("treats the same payload in another key order as the same request", async () => {
    const stub = env.InboxHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: InboxHarnessObject) => {
      // Bound to variables so the extra key passes the handler's payload
      // type; the stored payload keeps every key.
      const first = { value: "a", tags: { x: 1, y: 2 } };
      const reordered = { tags: { y: 2, x: 1 }, value: "a" };
      const submitted = await instance.inbox.submit("echo", first, {
        idempotencyKey: "order"
      });

      const again = await instance.inbox.submit("echo", reordered, {
        idempotencyKey: "order"
      });

      expect(again).toMatchObject({
        accepted: false,
        request: { id: submitted.request.id }
      });
    });
  });
});
