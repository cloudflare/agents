import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PiConversationView } from "../view";

/**
 * `projectView` turns pi's conversation view into this app's, on the server
 * and in the browser. A client that follows a run and one that joins after
 * it must end up with the same view.
 */
describe("the conversation view", () => {
  it("projects a run's last view as a late joiner sees it", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    const watching = stub.watch();
    const receipt = await stub.submit("multiply 5");
    await stub.wait(receipt.operationId);
    const view = JSON.parse(await watching) as PiConversationView;
    const late = JSON.parse(await stub.snapshotView()) as PiConversationView;
    expect(view.messages).toEqual(late.messages);
    expect(late.running).toBe(false);
    expect(late.error).toBeNull();
  });

  it("shows only the context after a reset", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    await stub.wait((await stub.submit("before the reset")).operationId);
    await stub.reset();
    await stub.wait((await stub.submit("after the reset")).operationId);
    const view = JSON.parse(await stub.snapshotView()) as PiConversationView;
    const texts = view.messages.map((message) =>
      message.parts.map((part) => ("text" in part ? part.text : "")).join("")
    );
    expect(texts[0]).toBe("Context reset");
    expect(texts).toContain("after the reset");
    expect(texts).not.toContain("before the reset");
  });
});
