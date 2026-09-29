import { describe, expect, it } from "vitest";
import { originMessageIds, withOriginMessageIds } from "../origin-message-ids";

describe("originMessageIds (#2280)", () => {
  it("returns the trailing run of user message ids", () => {
    expect(
      originMessageIds([
        { id: "u0", role: "user" },
        { id: "a0", role: "assistant" },
        { id: "u1", role: "user" },
        { id: "u2", role: "user" }
      ])
    ).toEqual(["u1", "u2"]);
  });

  it("returns undefined when the request does not end with a user message", () => {
    expect(
      originMessageIds([
        { id: "u0", role: "user" },
        { id: "a0", role: "assistant" }
      ])
    ).toBeUndefined();
    expect(originMessageIds([])).toBeUndefined();
    expect(originMessageIds("nope")).toBeUndefined();
  });
});

describe("withOriginMessageIds (#2280)", () => {
  it("adds ids to done and error frames only", () => {
    expect(withOriginMessageIds({ id: "r", done: true }, ["u1"])).toEqual({
      id: "r",
      done: true,
      messageIds: ["u1"]
    });
    expect(
      withOriginMessageIds({ id: "r", done: false, error: true }, ["u1"])
    ).toEqual({ id: "r", done: false, error: true, messageIds: ["u1"] });
    const chunk = { id: "r", done: false };
    expect(withOriginMessageIds(chunk, ["u1"])).toBe(chunk);
  });

  it("keeps ids a frame already carries", () => {
    const frame = { done: true, messageIds: ["own"] };
    expect(withOriginMessageIds(frame, ["other"])).toBe(frame);
  });
});
