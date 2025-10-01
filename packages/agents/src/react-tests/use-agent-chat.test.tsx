import { StrictMode, Suspense, act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useAgentChat } from "../ai-react";
import type { useAgent } from "../react";

function createAgent({ name, url }: { name: string; url: string }) {
  const target = new EventTarget();
  const baseAgent = {
    _pkurl: url,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: () => {},
    dispatchEvent: target.dispatchEvent.bind(target)
  };
  return baseAgent as unknown as ReturnType<typeof useAgent>;
}

describe("useAgentChat", () => {
  it("should cache initial message responses across re-renders", async () => {
    const agent = createAgent({
      name: "thread-alpha",
      url: "ws://localhost:3000/agents/chat/thread-alpha?_pk=abc"
    });

    const testMessages = [
      {
        id: "1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Hi" }]
      },
      {
        id: "2",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Hello" }]
      }
    ];

    const getInitialMessages = vi.fn(() => Promise.resolve(testMessages));

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages
      });
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
    };

    const suspenseRendered = vi.fn();
    const SuspenseObserver = () => {
      suspenseRendered();
      return "Suspended";
    };

    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<SuspenseObserver />}>{children}</Suspense>
          </StrictMode>
        )
      })
    );

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(testMessages));

    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(suspenseRendered).toHaveBeenCalled();

    suspenseRendered.mockClear();

    await screen.rerender(<TestComponent />);

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(testMessages));

    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(suspenseRendered).not.toHaveBeenCalled();
  });

  it("should refetch initial messages when the agent name changes", async () => {
    const url = "ws://localhost:3000/agents/chat/thread-a?_pk=abc";
    const agentA = createAgent({ name: "thread-a", url });
    const agentB = createAgent({ name: "thread-b", url });

    const getInitialMessages = vi.fn(async ({ name }: { name: string }) => [
      {
        id: "1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: `Hello from ${name}` }]
      }
    ]);

    const TestComponent = ({
      agent
    }: {
      agent: ReturnType<typeof useAgent>;
    }) => {
      const chat = useAgentChat({
        agent,
        getInitialMessages
      });
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
    };

    const suspenseRendered = vi.fn();
    const SuspenseObserver = () => {
      suspenseRendered();
      return "Suspended";
    };

    const screen = await act(() =>
      render(<TestComponent agent={agentA} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<SuspenseObserver />}>{children}</Suspense>
          </StrictMode>
        )
      })
    );

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Hello from thread-a");

    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(getInitialMessages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "thread-a" })
    );

    suspenseRendered.mockClear();

    await act(() => screen.rerender(<TestComponent agent={agentB} />));

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Hello from thread-b");

    expect(getInitialMessages).toHaveBeenCalledTimes(2);
    expect(getInitialMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "thread-b" })
    );
  });
});
