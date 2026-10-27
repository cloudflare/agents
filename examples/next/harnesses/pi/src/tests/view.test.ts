import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PiSessionView } from "../view";

/**
 * `projectView` turns pi's conversation view into this app's, on the server
 * and in the browser. A client that follows a run and one that joins after
 * it must end up with the same view.
 */
describe("the session view", () => {
  it("projects a run's last view as a late joiner sees it", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    const watching = stub.watch();
    const receipt = await stub.submit("multiply 5");
    await stub.wait(receipt.operationId);
    const view = JSON.parse(await watching) as PiSessionView;
    const late = JSON.parse(await stub.snapshotView()) as PiSessionView;
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
    expect(late.error).toBeNull();
  });
});
