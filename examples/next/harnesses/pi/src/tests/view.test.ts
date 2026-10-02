import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PiSessionView } from "../view";

/**
 * `reduceEvents` folds pi's agent events into this app's view, on the server
 * for a snapshot and in the browser for streamed batches. A client that
 * follows a run and one that joins after it must end up with the same view.
 */
describe("the session view", () => {
  it("folds a run's events into the same view a late joiner gets", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    const watching = stub.watch();
    const receipt = await stub.submit("multiply 5");
    await stub.wait(receipt.operationId);
    const { view: folded, types } = await watching;
    const view = JSON.parse(folded) as PiSessionView;
    for (const type of [
      "run_start",
      "tool_execution_start",
      "tool_execution_end",
      "run_end"
    ]) {
      expect(types).toContain(type);
    }
    const late = JSON.parse(await stub.snapshotView()) as PiSessionView;
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
  });
});
