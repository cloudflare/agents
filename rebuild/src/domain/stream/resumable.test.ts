import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createResumableStreamBuffer } from "./resumable.js";
import type { UiChunk } from "./chunks.js";
import type { KeyValueStore } from "../../ports/storage.js";
import type { TestClock } from "../../adapters/memory/clock.js";

function setup(retention?: { settledMs?: number; abandonedMs?: number }) {
  const store: KeyValueStore = createMemoryKeyValueStore();
  const clock: TestClock = createTestClock(0);
  const buffer = createResumableStreamBuffer({ store, clock, retention });
  return { store, clock, buffer };
}

const startChunk: UiChunk = { type: "start", messageId: "msg_1" };
const textChunk: UiChunk = { type: "text-delta", delta: "hi" };
const finishChunk: UiChunk = { type: "finish", finishReason: "stop" };

describe("createResumableStreamBuffer", () => {
  describe("append / read order", () => {
    it("returns chunks in the order they were appended", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      buffer.append("stream_1", startChunk);
      buffer.append("stream_1", textChunk);
      buffer.append("stream_1", finishChunk);

      const result = buffer.read("stream_1");
      expect(result).not.toBeNull();
      expect(result?.chunks).toEqual([startChunk, textChunk, finishChunk]);
      expect(result?.requestId).toBe("req_1");
    });

    it("read() on an unknown streamId returns null", () => {
      const { buffer } = setup();
      expect(buffer.read("nope")).toBeNull();
    });

    it("append() to an unknown streamId is a no-op (no throw)", () => {
      const { buffer } = setup();
      expect(() => buffer.append("nope", textChunk)).not.toThrow();
      expect(buffer.read("nope")).toBeNull();
    });
  });

  describe("status transitions", () => {
    it("starts active on begin()", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      expect(buffer.read("stream_1")?.status).toBe("active");
    });

    it("settle('completed') transitions status", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "completed");
      expect(buffer.read("stream_1")?.status).toBe("completed");
    });

    it("settle('errored') transitions status", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "errored");
      expect(buffer.read("stream_1")?.status).toBe("errored");
    });

    it("settle() on an unknown streamId is a no-op (no throw)", () => {
      const { buffer } = setup();
      expect(() => buffer.settle("nope", "completed")).not.toThrow();
    });
  });

  describe("activeStream()", () => {
    it("returns null when no stream has begun", () => {
      const { buffer } = setup();
      expect(buffer.activeStream()).toBeNull();
    });

    it("returns the streamId/requestId of the active stream after begin()", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      expect(buffer.activeStream()).toEqual({ streamId: "stream_1", requestId: "req_1" });
    });

    it("returns null after the active stream settles", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "completed");
      expect(buffer.activeStream()).toBeNull();
    });

    it("a new begin() supersedes the previous active pointer", () => {
      const { buffer } = setup();
      buffer.begin("stream_1", "req_1");
      buffer.begin("stream_2", "req_2");
      expect(buffer.activeStream()).toEqual({ streamId: "stream_2", requestId: "req_2" });
    });
  });

  describe("gc() retention", () => {
    it("does not reclaim a settled stream before its retention window elapses", () => {
      const { buffer, clock } = setup({ settledMs: 10_000 });
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "completed");
      clock.advance(9_999);
      expect(buffer.gc()).toBe(0);
      expect(buffer.read("stream_1")).not.toBeNull();
    });

    it("reclaims a settled stream once its retention window has elapsed", () => {
      const { buffer, clock } = setup({ settledMs: 10_000 });
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "completed");
      clock.advance(10_000);
      expect(buffer.gc()).toBe(1);
      expect(buffer.read("stream_1")).toBeNull();
    });

    it("does not reclaim an active stream before the abandoned window elapses since its last chunk", () => {
      const { buffer, clock } = setup({ abandonedMs: 5_000 });
      buffer.begin("stream_1", "req_1");
      buffer.append("stream_1", textChunk);
      clock.advance(4_999);
      expect(buffer.gc()).toBe(0);
      expect(buffer.read("stream_1")).not.toBeNull();
    });

    it("reclaims an abandoned active stream once the window has elapsed since its last chunk", () => {
      const { buffer, clock } = setup({ abandonedMs: 5_000 });
      buffer.begin("stream_1", "req_1");
      buffer.append("stream_1", textChunk);
      clock.advance(5_000);
      expect(buffer.gc()).toBe(1);
      expect(buffer.read("stream_1")).toBeNull();
    });

    it("measures the abandoned window from the last chunk, not from begin()", () => {
      const { buffer, clock } = setup({ abandonedMs: 5_000 });
      buffer.begin("stream_1", "req_1");
      clock.advance(4_000);
      buffer.append("stream_1", textChunk); // resets the clock for abandonment purposes
      clock.advance(4_000);
      // Only 4s since last chunk (8s since begin) -> still alive.
      expect(buffer.gc()).toBe(0);
      expect(buffer.read("stream_1")).not.toBeNull();
    });

    it("clears the active pointer when the active stream is reclaimed", () => {
      const { buffer, clock } = setup({ abandonedMs: 5_000 });
      buffer.begin("stream_1", "req_1");
      clock.advance(5_000);
      buffer.gc();
      expect(buffer.activeStream()).toBeNull();
    });

    it("reclaims multiple eligible streams in one gc() call and reports the count", () => {
      const { buffer, clock } = setup({ settledMs: 1_000, abandonedMs: 5_000 });
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "completed");
      buffer.begin("stream_2", "req_2");
      buffer.settle("stream_2", "errored");
      buffer.begin("stream_3", "req_3"); // stays active and fresh (abandonedMs not elapsed)

      clock.advance(1_000);
      const reclaimed = buffer.gc();
      expect(reclaimed).toBe(2);
      expect(buffer.read("stream_1")).toBeNull();
      expect(buffer.read("stream_2")).toBeNull();
      expect(buffer.read("stream_3")).not.toBeNull();
    });

    it("uses default retention windows when none are configured", () => {
      const { buffer, clock } = setup();
      buffer.begin("stream_1", "req_1");
      buffer.settle("stream_1", "completed");
      clock.advance(600_000 - 1);
      expect(buffer.gc()).toBe(0);
      clock.advance(1);
      expect(buffer.gc()).toBe(1);
    });
  });

  describe("persistence across buffer recreation", () => {
    it("an active stream's chunks survive recreating the buffer over the same store", () => {
      const store = createMemoryKeyValueStore();
      const clock = createTestClock(0);
      const buffer1 = createResumableStreamBuffer({ store, clock });
      buffer1.begin("stream_1", "req_1");
      buffer1.append("stream_1", startChunk);
      buffer1.append("stream_1", textChunk);

      const buffer2 = createResumableStreamBuffer({ store, clock });
      const result = buffer2.read("stream_1");
      expect(result).toEqual({ chunks: [startChunk, textChunk], status: "active", requestId: "req_1" });
      expect(buffer2.activeStream()).toEqual({ streamId: "stream_1", requestId: "req_1" });
    });
  });
});
