import { describe, it, expect } from "vitest";
import { CHAT_MESSAGE_TYPES } from "../protocol";
import {
  HANDSHAKE_INVARIANTS,
  recoveringFrame,
  replayDoneFrame,
  streamResumeNoneFrame,
  streamResumingFrame,
  terminalErrorFrame
} from "./resume-handshake-frames";

/**
 * Freezes the resume-handshake wire frames (Tier-2). These exact shapes are the
 * byte-identical gate for the T2-2 extraction of `resume-handshake.ts`: the
 * shared module must emit frames that `toEqual` these builders. Snapshots are
 * inlined (not auto-updated) so a drift fails loudly and is reviewed.
 */
describe("resume-handshake golden frames", () => {
  it("STREAM_RESUMING carries the request id", () => {
    expect(streamResumingFrame("req-1")).toEqual({
      type: "cf_agent_stream_resuming",
      id: "req-1"
    });
  });

  it("STREAM_RESUME_NONE carries no id", () => {
    const frame = streamResumeNoneFrame();
    expect(frame).toEqual({ type: "cf_agent_stream_resume_none" });
    expect("id" in frame).toBe(false);
  });

  it("replay-done frame is a clean close: replay:true, no error", () => {
    const frame = replayDoneFrame("req-1");
    expect(frame).toEqual({
      body: "",
      done: true,
      id: "req-1",
      type: "cf_agent_use_chat_response",
      replay: true
    });
    expect("error" in frame).toBe(false);
  });

  it("terminal error frame mirrors a live terminal: error:true, no replay flag", () => {
    const frame = terminalErrorFrame("req-1", "boom");
    expect(frame).toEqual({
      body: "boom",
      done: true,
      error: true,
      id: "req-1",
      type: "cf_agent_use_chat_response"
    });
    // #1645/#1575: it must NOT look like a benign replay close.
    expect("replay" in frame).toBe(false);
  });

  it("recovering frame includes the id only when present", () => {
    expect(recoveringFrame("req-1")).toEqual({
      type: "cf_agent_chat_recovering",
      recovering: true,
      id: "req-1"
    });
    const noId = recoveringFrame(undefined);
    expect(noId).toEqual({
      type: "cf_agent_chat_recovering",
      recovering: true
    });
    expect("id" in noId).toBe(false);
  });

  it("frame types match the shared protocol constants", () => {
    expect(streamResumingFrame("x").type).toBe(
      CHAT_MESSAGE_TYPES.STREAM_RESUMING
    );
    expect(streamResumeNoneFrame().type).toBe(
      CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
    );
    expect(replayDoneFrame("x").type).toBe(
      CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    );
    expect(terminalErrorFrame("x", "y").type).toBe(
      CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
    );
    expect(recoveringFrame("x").type).toBe(CHAT_MESSAGE_TYPES.CHAT_RECOVERING);
  });

  it("a host with a distinct use-chat-response constant is honored", () => {
    expect(replayDoneFrame("req-1", "custom_response").type).toBe(
      "custom_response"
    );
    expect(terminalErrorFrame("req-1", "boom", "custom_response").type).toBe(
      "custom_response"
    );
  });

  it("documents the load-bearing handshake invariants", () => {
    expect(HANDSHAKE_INVARIANTS.resumingSentOnBothNotifyAndRequest).toBe(true);
    expect(
      HANDSHAKE_INVARIANTS.terminalExcludedFromIdleConnectDeliveredViaHandshake
    ).toBe(true);
    expect(HANDSHAKE_INVARIANTS.idleConnectPayloadDiverges).toEqual({
      aiChat: "recovering-only",
      think: "transcript + recovering"
    });
  });
});
