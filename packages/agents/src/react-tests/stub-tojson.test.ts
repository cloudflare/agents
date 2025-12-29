import { describe, expect, it, vi } from "vitest";
import { _testUtils } from "../react";

/**
 * The stub proxy should not make RPC calls for internal JS methods like toJSON,
 * which are accessed by console.log and JSON.stringify.
 */

const { createStubProxy } = _testUtils;

describe("Stub proxy toJSON handling (issue #753)", () => {
  it("does not trigger RPC for toJSON", () => {
    const mockCall = vi.fn();
    const stub = createStubProxy(mockCall);

    expect(stub.toJSON).toBeUndefined();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("does not trigger RPC for other internal methods", () => {
    const mockCall = vi.fn();
    const stub = createStubProxy(mockCall);

    expect(stub.then).toBeUndefined();
    expect(stub.valueOf).toBeUndefined();
    expect(stub.toString).toBeUndefined();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("still allows regular RPC method calls", () => {
    const mockCall = vi.fn();
    const stub = createStubProxy(mockCall);

    (stub.myMethod as Function)("arg1", 123);

    expect(mockCall).toHaveBeenCalledWith("myMethod", ["arg1", 123]);
  });

  it("allows JSON.stringify without RPC calls", () => {
    const mockCall = vi.fn();
    const stub = createStubProxy(mockCall);

    const result = JSON.stringify({ data: "test", stub });

    expect(result).toBe('{"data":"test","stub":{}}');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("handles MessageEvent.target.stub serialization (issue scenario)", () => {
    const mockCall = vi.fn();
    const stub = createStubProxy(mockCall);

    // Simulate the exact scenario: MessageEvent with target containing stub
    const messageEvent = {
      data: '{"type":"message"}',
      target: { stub }
    };

    // Simulate console.log traversing and checking toJSON
    expect(messageEvent.target.stub.toJSON).toBeUndefined();
    JSON.stringify(messageEvent);

    expect(mockCall).not.toHaveBeenCalled();
  });
});
