import { afterEach, describe, expect, it, vi } from "vitest";
import { EndedRequests } from "../chat-frames";

describe("EndedRequests", () => {
  afterEach(() => vi.useRealTimers());

  it("counts a sub-agent socket the root accepted before a broadcast it was not left out of as told (F5c)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const ended = new EndedRequests();
    // A facet's start broadcasts the end before it knows its sockets.
    ended.broadcast("req-1", ["resuming-tab"]);

    // The socket the root accepted before: it got the frame.
    expect(ended.has({ id: "tab", acceptedAt: 9_000 }, "req-1")).toBe(true);
    // A same-id socket accepted after the broadcast: it did not.
    expect(ended.has({ id: "tab", acceptedAt: 11_000 }, "req-1")).toBe(false);
    // Accepted in the broadcast's millisecond: maybe after it, so not told.
    expect(ended.has({ id: "tab", acceptedAt: 10_000 }, "req-1")).toBe(false);
    // A socket the broadcast left out.
    expect(ended.has({ id: "resuming-tab", acceptedAt: 9_000 }, "req-1")).toBe(
      false
    );
    // A root socket (no acceptedAt) is known by its object only.
    expect(ended.has({ id: "root-tab" }, "req-1")).toBe(false);
    // Another request.
    expect(ended.has({ id: "tab", acceptedAt: 9_000 }, "req-2")).toBe(false);
  });

  it("still knows a socket it noted by object", () => {
    const ended = new EndedRequests();
    const socket = { id: "tab" };
    ended.note(socket, "req-1");
    expect(ended.has(socket, "req-1")).toBe(true);
    expect(ended.has({ id: "tab" }, "req-1")).toBe(false);
  });
});
