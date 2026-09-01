import { describe, expect, it } from "vitest";
import { parse } from "../harness/partial-json";

describe("Worker-safe partial JSON parser", () => {
  it("preserves complete tool arguments from an incomplete object", () => {
    expect(parse('{"left":47,"operation":"mul')).toEqual({
      left: 47,
      operation: "mul"
    });
    expect(parse('{"left":47,"operation":"multiply","right":1')).toEqual({
      left: 47,
      operation: "multiply",
      right: 1
    });
  });

  it("retains complete nested values and partial atoms", () => {
    expect(parse('[{"a":1},{"b":')).toEqual([{ a: 1 }, {}]);
    expect(parse('"hello')).toBe("hello");
    expect(parse("tru")).toBe(true);
    expect(parse("nul")).toBeNull();
    expect(parse("1e")).toBe(1);
    expect(parse("-Inf")).toBe(Number.NEGATIVE_INFINITY);
  });
});
