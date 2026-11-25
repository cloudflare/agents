import { describe, expect, it } from "vitest";
import { drawQueuedLast, splitQueuedMessages } from "../queued-messages";

const m = (id: string) => ({ id });
const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);

describe("splitQueuedMessages", () => {
  it("keeps queued messages out of the stored list", () => {
    const { stored, queued } = splitQueuedMessages(
      [m("u1"), m("a1"), m("u2"), m("u3")],
      ["u2", "u3"]
    );
    expect(ids(stored)).toEqual(["u1", "a1"]);
    expect(ids(queued)).toEqual(["u2", "u3"]);
  });

  it("is the whole list when nothing is queued", () => {
    const { stored, queued } = splitQueuedMessages([m("u1")], undefined);
    expect(ids(stored)).toEqual(["u1"]);
    expect(queued).toEqual([]);
  });
});

describe("drawQueuedLast", () => {
  it("draws queued messages after the rest, a streaming reply included", () => {
    expect(ids(drawQueuedLast([m("u1"), m("a1")], [m("u2")]))).toEqual([
      "u1",
      "a1",
      "u2"
    ]);
  });

  it("draws a queued message the chat also holds once, last", () => {
    expect(ids(drawQueuedLast([m("u1"), m("u2"), m("a1")], [m("u2")]))).toEqual(
      ["u1", "a1", "u2"]
    );
  });

  it("returns the same list when nothing is queued", () => {
    const messages = [m("u1"), m("a1")];
    expect(drawQueuedLast(messages, [])).toBe(messages);
  });
});
