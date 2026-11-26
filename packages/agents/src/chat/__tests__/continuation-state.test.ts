import { describe, it, expect } from "vitest";
import { continuationTargetIsLatest } from "../continuation-state";

describe("continuationTargetIsLatest", () => {
  const messages = [{ id: "user-1" }, { id: "assistant-1" }];

  it("is true while the target message is the last message", () => {
    expect(
      continuationTargetIsLatest(messages, {
        targetMessageIds: ["assistant-1"]
      })
    ).toBe(true);
  });

  it("is false once a newer message follows the target, or the target is gone", () => {
    expect(
      continuationTargetIsLatest([...messages, { id: "user-2" }], {
        targetMessageIds: ["assistant-1"]
      })
    ).toBe(false);
    expect(
      continuationTargetIsLatest([], { targetMessageIds: ["assistant-1"] })
    ).toBe(false);
  });

  it("is true while any of several targets is the last message", () => {
    expect(
      continuationTargetIsLatest(messages, {
        targetMessageIds: ["assistant-2", "assistant-1"]
      })
    ).toBe(true);
  });

  describe("messages after the target", () => {
    const user1 = { id: "user-1", role: "user" };
    const reply = { id: "assistant-1", role: "assistant" };
    const note = { id: "note-1", role: "assistant" };
    const pending = { targetMessageIds: ["assistant-1"] };

    it("is false when a message appended without a turn follows the target", () => {
      // A status note an app stored with `persistMessages`. The result stays
      // stored, and the next turn reads it.
      expect(continuationTargetIsLatest([user1, reply, note], pending)).toBe(
        false
      );
    });

    it("is false when a newer question follows the target", () => {
      expect(
        continuationTargetIsLatest(
          [user1, reply, { id: "user-2", role: "user" }],
          pending
        )
      ).toBe(false);
    });

    it("is false when a later reply follows the target", () => {
      expect(
        continuationTargetIsLatest(
          [
            user1,
            { id: "user-2", role: "user" },
            reply,
            { id: "assistant-2", role: "assistant" }
          ],
          pending
        )
      ).toBe(false);
    });

    it("is true for the last of several targets when it is the last message", () => {
      expect(
        continuationTargetIsLatest(
          [user1, { id: "assistant-0", role: "assistant" }, reply],
          { targetMessageIds: ["assistant-0", "assistant-1"] }
        )
      ).toBe(true);
    });
  });
});
