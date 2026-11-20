import { describe, expect, it } from "vitest";
import { drawQueuedLast } from "../queued-messages";

const m = (id: string) => ({ id });

describe("drawQueuedLast", () => {
  it("draws queued messages after the rest, a streaming reply included", () => {
    const messages = [m("u1"), m("u2"), m("a1")];
    expect(drawQueuedLast(messages, new Set(["u2"])).map((x) => x.id)).toEqual([
      "u1",
      "a1",
      "u2"
    ]);
  });

  it("keeps queued messages in the order they came", () => {
    const messages = [m("u1"), m("u2"), m("u3"), m("a1")];
    expect(
      drawQueuedLast(messages, new Set(["u3", "u2"])).map((x) => x.id)
    ).toEqual(["u1", "a1", "u2", "u3"]);
  });

  it("returns the same list when nothing is queued or it is last already", () => {
    const messages = [m("u1"), m("a1"), m("u2")];
    expect(drawQueuedLast(messages, new Set())).toBe(messages);
    expect(drawQueuedLast(messages, new Set(["u2"]))).toBe(messages);
    expect(drawQueuedLast(messages, new Set(["gone"]))).toBe(messages);
  });
});
