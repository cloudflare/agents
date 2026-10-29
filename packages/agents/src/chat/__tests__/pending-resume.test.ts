import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketChatTransport } from "../ws-chat-transport";
import { MessageType } from "../wire-types";

function setup() {
  const agent = {
    send: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  const onPendingServerTurnChange = vi.fn();
  const transport = new WebSocketChatTransport({
    agent,
    onPendingServerTurnChange
  });
  return { agent, transport, onPendingServerTurnChange };
}

afterEach(() => vi.useRealTimers());

describe("accepted pre-stream resume turns", () => {
  it("cancels the pending turn and releases the probe exactly once", async () => {
    const { agent, transport, onPendingServerTurnChange } = setup();
    const probe = transport.reconnectToStream({ chatId: "chat" });
    transport.handleStreamPending({ id: "queued" });
    expect(transport.pendingServerTurnId).toBe("queued");
    expect(onPendingServerTurnChange).toHaveBeenLastCalledWith("queued");
    expect(transport.cancelActiveServerTurn()).toBe(true);
    await expect(probe).resolves.toBeNull();
    expect(agent.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        id: "queued",
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
      })
    );
    expect(transport.pendingServerTurnId).toBeNull();
    expect(onPendingServerTurnChange).toHaveBeenLastCalledWith(null);
    expect(transport.cancelActiveServerTurn()).toBe(false);
    expect(transport.handleStreamPending({ id: "late" })).toBe(false);
  });

  it.each(["none", "timeout", "reset", "abort"])(
    "clears pending activity on %s without cancelling server work",
    async (settlement) => {
      vi.useFakeTimers();
      const { agent, transport, onPendingServerTurnChange } = setup();
      const controller = new AbortController();
      const probe = transport.reconnectToStream({
        chatId: "chat",
        abortSignal: controller.signal
      });
      transport.handleStreamPending({ id: "queued" });
      if (settlement === "none") transport.handleStreamResumeNone();
      if (settlement === "timeout") await vi.advanceTimersByTimeAsync(60000);
      if (settlement === "reset") transport.resetResumeState();
      if (settlement === "abort") controller.abort();
      await expect(probe).resolves.toBeNull();
      expect(transport.pendingServerTurnId).toBeNull();
      expect(onPendingServerTurnChange).toHaveBeenLastCalledWith(null);
      expect(transport.isAwaitingResume()).toBe(false);
      expect(agent.send).toHaveBeenCalledTimes(1);
      const next = transport.reconnectToStream({ chatId: "chat" });
      transport.handleStreamResumeNone();
      await expect(next).resolves.toBeNull();
    }
  );

  it("hands pending activity over to the attached stream", async () => {
    const { transport } = setup();
    const probe = transport.reconnectToStream({ chatId: "chat" });
    transport.handleStreamPending({ id: "queued" });
    transport.handleStreamResuming({ id: "queued" });
    expect(await probe).toBeInstanceOf(ReadableStream);
    expect(transport.pendingServerTurnId).toBeNull();
    expect(transport.activeServerTurnId).toBe("queued");
    transport.cancelActiveServerTurn();
  });

  it("does not send a probe for a signal already aborted", async () => {
    const { agent, transport } = setup();
    await expect(
      transport.reconnectToStream({
        chatId: "chat",
        abortSignal: AbortSignal.abort()
      })
    ).resolves.toBeNull();
    expect(agent.send).not.toHaveBeenCalled();
  });
});
