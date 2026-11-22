import { describe, expect, it } from "vitest";
import {
  interruptedTurnKind,
  planInterruptedTurn,
  questionToRetry
} from "../interrupted-turn";
import type { ChatFiberSnapshot } from "../recovery";

const newTurn: ChatFiberSnapshot = {
  kind: "test",
  version: 1,
  requestId: "r1",
  continuation: false,
  latestMessageId: "u1",
  latestMessageRole: "user",
  latestUserMessageId: "u1",
  startedAt: 0
};
const continuation: ChatFiberSnapshot = {
  ...newTurn,
  continuation: true,
  latestMessageId: "a1",
  latestMessageRole: "assistant"
};
const regeneration: ChatFiberSnapshot = {
  ...newTurn,
  latestMessageId: "a1",
  latestMessageRole: "assistant",
  branchParentId: "u1"
};
const question = { id: "u1", role: "user" };
const reply = { id: "a1", role: "assistant" };

describe("questionToRetry", () => {
  it("is the question of a new turn that is still the latest message", () => {
    expect(questionToRetry(newTurn, question)).toEqual({ questionId: "u1" });
  });

  it("is nothing for a continuation, a reply leaf, a newer question or no snapshot", () => {
    expect(questionToRetry(continuation, question)).toBeNull();
    expect(questionToRetry(newTurn, reply)).toBeNull();
    expect(questionToRetry(newTurn, { id: "u2", role: "user" })).toBeNull();
    expect(questionToRetry(null, question)).toBeNull();
    expect(questionToRetry(newTurn, undefined)).toBeNull();
  });

  it("is the branch parent of a regeneration whose replaced reply is still the leaf", () => {
    expect(questionToRetry(regeneration, reply)).toEqual({
      questionId: "u1",
      regeneratedLeafId: "a1"
    });
    expect(questionToRetry(regeneration, question)).toBeNull();
  });
});

describe("interruptedTurnKind", () => {
  it("is retry for a new turn that left nothing, continue otherwise", () => {
    expect(interruptedTurnKind({ snapshot: newTurn }, false, question)).toBe(
      "retry"
    );
    expect(interruptedTurnKind({ snapshot: newTurn }, true, question)).toBe(
      "continue"
    );
    expect(interruptedTurnKind({ snapshot: continuation }, false, reply)).toBe(
      "continue"
    );
  });

  it("is continue when the stream ended before the reset", () => {
    expect(
      interruptedTurnKind(
        { snapshot: newTurn, streamStatus: "completed" },
        false,
        question
      )
    ).toBe("continue");
  });
});

describe("planInterruptedTurn", () => {
  it("skips a stream that ended before the reset, before anything else", () => {
    for (const streamStatus of ["completed", "error"] as const) {
      expect(
        planInterruptedTurn(
          { snapshot: newTurn, streamStatus },
          { continue: false },
          question
        )
      ).toEqual({ action: "skip", reason: "stream_terminal" });
    }
  });

  it("obeys an app that declined to continue", () => {
    expect(
      planInterruptedTurn({ snapshot: newTurn }, { continue: false }, question)
    ).toEqual({ action: "skip", reason: "continue_disabled" });
  });

  it("answers the question again when it is still the latest message", () => {
    // Also when the turn streamed text and `persist: false` dropped it.
    expect(planInterruptedTurn({ snapshot: newTurn }, {}, question)).toEqual({
      action: "retry",
      questionId: "u1"
    });
    expect(planInterruptedTurn({ snapshot: regeneration }, {}, reply)).toEqual({
      action: "retry",
      questionId: "u1",
      regeneratedLeafId: "a1"
    });
  });

  it("continues the reply that is the latest message", () => {
    expect(planInterruptedTurn({ snapshot: newTurn }, {}, reply)).toEqual({
      action: "continue",
      replyId: "a1"
    });
    expect(planInterruptedTurn({ snapshot: continuation }, {}, reply)).toEqual({
      action: "continue",
      replyId: "a1"
    });
  });

  it("skips when a newer question is the latest message", () => {
    expect(
      planInterruptedTurn(
        { snapshot: continuation },
        {},
        { id: "u2", role: "user" }
      )
    ).toEqual({ action: "skip", reason: "conversation_changed" });
  });
});
