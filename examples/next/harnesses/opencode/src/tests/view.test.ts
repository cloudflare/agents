import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { OpenCodeSessionView } from "../view";

/**
 * `reduceEvents` folds the harness's events into this app's view, on the
 * server for a snapshot and in the browser for streamed batches. A client
 * that follows a turn and one that joins after it must end up with the same
 * view.
 */
describe("the session view", () => {
  it("folds a turn's events into the same view a late joiner gets", async () => {
    const stub = env.OPENCODE_HARNESS_TEST.getByName(crypto.randomUUID());
    await stub.watch();
    const receipt = await stub.submit("multiply 5");
    await stub.wait(receipt.operationId);
    const { view: folded, types } = await stub.watched();
    const view = JSON.parse(folded) as OpenCodeSessionView;
    for (const type of ["operation_start", "tool_start", "operation_end"]) {
      expect(types).toContain(type);
    }
    const late = JSON.parse(await stub.snapshotView()) as OpenCodeSessionView;
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
  });
});
