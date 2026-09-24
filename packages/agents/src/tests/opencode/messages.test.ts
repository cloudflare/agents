import { describe, expect, it } from "vitest";
import { hasOpenCodeOperation } from "../../opencode/messages";

describe("hasOpenCodeOperation", () => {
  it("finds the stable user message in both response shapes", () => {
    const message = { info: { id: "msg_op-1", role: "user" } };

    expect(hasOpenCodeOperation([message], "op-1")).toBe(true);
    expect(hasOpenCodeOperation({ messages: [message] }, "op-1")).toBe(true);
    expect(hasOpenCodeOperation([message], "op-2")).toBe(false);
    expect(hasOpenCodeOperation(undefined, "op-1")).toBe(false);
  });
});
