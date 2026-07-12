import { describe, expect, it } from "vitest";
import {
  AbortedError,
  AgentError,
  ConflictError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  toErrorValue,
} from "./errors.js";

describe("error taxonomy", () => {
  it("ValidationError is an AgentError with code 'validation'", () => {
    const err = new ValidationError("bad input");
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("validation");
    expect(err.message).toBe("bad input");
  });

  it("NotFoundError has code 'not_found'", () => {
    expect(new NotFoundError("missing").code).toBe("not_found");
  });

  it("ConflictError has code 'conflict'", () => {
    expect(new ConflictError("mismatch").code).toBe("conflict");
  });

  it("AbortedError has code 'aborted'", () => {
    expect(new AbortedError("cancelled").code).toBe("aborted");
  });

  it("TimeoutError has code 'timeout'", () => {
    expect(new TimeoutError("deadline exceeded").code).toBe("timeout");
  });
});

describe("toErrorValue", () => {
  it("converts an Error instance", () => {
    const value = toErrorValue(new Error("boom"));
    expect(value.name).toBe("Error");
    expect(value.message).toBe("boom");
  });

  it("preserves the code of an AgentError subclass", () => {
    const value = toErrorValue(new ValidationError("bad"));
    expect(value.name).toBe("ValidationError");
    expect(value.message).toBe("bad");
    expect(value["code"]).toBe("validation");
  });

  it("converts a string throwable", () => {
    const value = toErrorValue("oops");
    expect(value.message).toBe("oops");
    expect(typeof value.name).toBe("string");
  });

  it("converts a plain object throwable", () => {
    const value = toErrorValue({ foo: "bar" });
    expect(value.message).toContain("bar");
  });

  it("never throws on undefined", () => {
    expect(() => toErrorValue(undefined)).not.toThrow();
    const value = toErrorValue(undefined);
    expect(typeof value.message).toBe("string");
  });

  it("never throws on null", () => {
    expect(() => toErrorValue(null)).not.toThrow();
  });
});
