import { describe, expect, it } from "vitest";
import {
  contextIdFromTaskId,
  mintTaskId,
  validateContextId,
  workflowInstanceId
} from "../src/runtime/ids";

describe("task IDs", () => {
  it("round-trips the context ID", () => {
    const contextId = "conversation-123";
    expect(contextIdFromTaskId(mintTaskId(contextId))).toBe(contextId);
  });

  it("round-trips Unicode context IDs", () => {
    const contextId = "chat-東京";
    expect(contextIdFromTaskId(mintTaskId(contextId))).toBe(contextId);
  });

  it("round-trips a well-formed UTF-16 surrogate pair", () => {
    const contextId = "chat-\ud83d\ude80";
    expect(contextIdFromTaskId(mintTaskId(contextId))).toBe(contextId);
  });

  it.each(["\ud800", "\udc00", "before-\ud800-after"])(
    "rejects a non-well-formed context ID before minting",
    (contextId) => {
      expect(() => validateContextId(contextId)).toThrow("well-formed UTF-16");
      expect(() => mintTaskId(contextId)).toThrow("well-formed UTF-16");
    }
  );

  it("rejects malformed task IDs", () => {
    expect(() => contextIdFromTaskId("not-a-task-id")).toThrow("server-issued");
  });

  it("bounds context IDs used for reversible task routing", () => {
    expect(() => validateContextId("x".repeat(46))).toThrow("45 UTF-8 bytes");
    expect(mintTaskId("x".repeat(45)).length).toBeLessThanOrEqual(100);
  });

  it("derives fixed-length Workflow IDs at the context boundary", () => {
    const taskId = mintTaskId("x".repeat(45));
    expect(workflowInstanceId(taskId, 1)).toHaveLength(43);
    expect(workflowInstanceId(taskId, 2)).toHaveLength(43);
    expect(workflowInstanceId(taskId, 2)).not.toBe(
      workflowInstanceId(taskId, 1)
    );
  });

  it("rejects invalid Workflow turns and foreign task IDs", () => {
    const taskId = mintTaskId("context");
    expect(() => workflowInstanceId(taskId, 0)).toThrow(
      "positive safe integer"
    );
    expect(() => workflowInstanceId("foreign-task", 1)).toThrow(
      "server-issued"
    );
  });
});
