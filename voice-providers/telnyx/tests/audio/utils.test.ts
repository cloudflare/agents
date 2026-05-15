import { describe, it, expect } from "vitest";
import { float32ToInt16, computeRMS } from "../../src/audio/utils.js";

describe("float32ToInt16", () => {
  it("converts silence to zero Int16 samples", () => {
    const result = float32ToInt16(new Float32Array([0, 0, 0, 0]));

    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(4);
    expect(Array.from(result)).toEqual([0, 0, 0, 0]);
  });

  it("converts full-scale positive to 32767", () => {
    expect(float32ToInt16(new Float32Array([1]))[0]).toBe(32767);
  });

  it("converts full-scale negative to -32768", () => {
    expect(float32ToInt16(new Float32Array([-1]))[0]).toBe(-32768);
  });

  it("clamps values beyond the -1..1 range", () => {
    const result = float32ToInt16(new Float32Array([1.5, -1.5]));

    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(-32768);
  });

  it("converts mid-range values", () => {
    expect(float32ToInt16(new Float32Array([0.5]))[0]).toBe(16383);
  });
});

describe("computeRMS", () => {
  it("returns 0 for silence", () => {
    expect(computeRMS(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it("returns 1 for full-scale DC signal", () => {
    expect(computeRMS(new Float32Array([1, 1, 1, 1]))).toBeCloseTo(1, 5);
  });

  it("computes RMS for a known signal", () => {
    expect(computeRMS(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(
      0.5,
      5
    );
  });

  it("returns 0 for an empty array", () => {
    expect(computeRMS(new Float32Array([]))).toBe(0);
  });
});
