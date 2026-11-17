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

  it("shows only the context after a reset", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    await stub.wait((await stub.submit("before the reset")).operationId);
    await stub.reset();
    await stub.wait((await stub.submit("after the reset")).operationId);
    const view = JSON.parse(await stub.snapshotView()) as PiSessionView;
    const texts = view.messages.map((message) =>
      message.parts.map((part) => ("text" in part ? part.text : "")).join("")
    );
    expect(texts[0]).toBe("Context reset");
    expect(texts).toContain("after the reset");
    expect(texts).not.toContain("before the reset");
  });

  it("shows a compaction as a summary notice, not a user message", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    await stub.wait((await stub.submit("first question")).operationId);
    await stub.wait((await stub.submit("second question")).operationId);
    await stub.compact();
    const view = JSON.parse(await stub.snapshotView()) as PiSessionView;
    const text = (message: PiSessionView["messages"][number]) =>
      message.parts.map((part) => ("text" in part ? part.text : "")).join("");
    const summaries = view.messages.filter(
      (message) => message.role === "summary"
    );
    expect(summaries).toHaveLength(1);
    // The faux model echoes the summarization prompt: the summary, unwrapped.
    expect(text(summaries[0])).toMatch(/^echo: /);
    expect(text(summaries[0])).not.toContain("<summary>");
    // The messages it summarized still show, in place.
    expect(view.messages.map(text)).toContain("first question");
    for (const message of view.messages) {
      if (message.role === "user") {
        expect(text(message)).not.toContain("<summary>");
      }
    }
  });
});
