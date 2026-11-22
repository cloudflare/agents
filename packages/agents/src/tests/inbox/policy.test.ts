import { describe, expect, it } from "vitest";
import { arrival, normalizePolicy } from "../../inbox/policy";

describe("Inbox arrival policy", () => {
  it("reduces a policy to what the record stores", () => {
    expect(normalizePolicy(undefined)).toEqual({
      name: "queue",
      debounceMs: null
    });
    for (const name of ["queue", "latest", "merge", "drop"] as const) {
      expect(normalizePolicy(name)).toEqual({ name, debounceMs: null });
    }
    expect(normalizePolicy({ debounceMs: 0 })).toEqual({
      name: "debounce",
      debounceMs: 0
    });
  });

  it("rejects what is not a policy", () => {
    // @ts-expect-error not a policy
    expect(() => normalizePolicy("newest")).toThrow(/Unknown inbox policy/);
    for (const debounceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizePolicy({ debounceMs })).toThrow(/debounceMs/);
    }
  });

  it("overlaps or drops only when the lane is busy", () => {
    const of = (policy: Parameters<typeof normalizePolicy>[0], busy: boolean) =>
      arrival(normalizePolicy(policy), busy);
    for (const policy of ["queue", "latest", "merge", "drop"] as const) {
      expect(of(policy, false)).toEqual({ overlap: false, dropped: false });
    }
    expect(of({ debounceMs: 5 }, false)).toEqual({
      overlap: false,
      dropped: false
    });
    expect(of("queue", true)).toEqual({ overlap: false, dropped: false });
    expect(of("drop", true)).toEqual({ overlap: false, dropped: true });
    for (const policy of ["latest", "merge", { debounceMs: 5 }] as const) {
      expect(of(policy, true)).toEqual({ overlap: true, dropped: false });
    }
  });
});
