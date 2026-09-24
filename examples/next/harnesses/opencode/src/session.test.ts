import { describe, expect, it } from "vitest";
import { createSessionName } from "./session";

describe("createSessionName", () => {
  it("returns a 12-character alphanumeric identifier", () => {
    for (let index = 0; index < 1_000; index += 1) {
      expect(createSessionName()).toMatch(/^[A-Za-z0-9]{12}$/);
    }
  });

  it("rejects random bytes outside the unbiased alphabet range", () => {
    const batches = [
      new Uint8Array(12).fill(255),
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    ];
    let call = 0;

    expect(
      createSessionName((target) => {
        target.set(batches[call]);
        call += 1;
        return target;
      })
    ).toBe("0123456789AB");
    expect(call).toBe(2);
  });
});
