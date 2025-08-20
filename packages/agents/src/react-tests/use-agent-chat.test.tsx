import { StrictMode, Suspense, act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useAgentChat } from "../ai-react";
import type { useAgent } from "../react";

// mock the @ai-sdk/react package
vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn((args) => ({
    messages: args.initialMessages,
    setMessages: vi.fn()
  }))
}));

/**
 * Unit tests for the hook functionality which mock the network
 * layer and @ai-sdk dependencies.
 */
describe("useAgentChat", () => {
  it("should cache initial message responses across re-renders", async () => {
    // mocking the agent with a subset of fields used in useAgentChat
    const mockAgent: ReturnType<typeof useAgent> = {
      _pkurl: "ws://localhost:3000",
      _url: "ws://localhost:3000",
      addEventListener: vi.fn(),
      id: "fake-agent",
      name: "fake-agent",
      removeEventListener: vi.fn(),
      send: vi.fn()
      // biome-ignore lint/suspicious/noExplicitAny: tests
    } as any;

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

    // We can observe how many times Suspense was triggered with this component.
    const suspenseRendered = vi.fn();
    const SuspenseObserver = () => {
      suspenseRendered();
      return "Suspended";
    };

    const TestComponent = () => {
      const chat = useAgentChat({
        agent: mockAgent,
        getInitialMessages
      });

      // NOTE: this only works because of how @ai-sdk/react is mocked to use
      // the initialMessages prop as the messages state in the mock return value.
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
    };

    // wrapping in act is required to resolve the suspense boundary during
    // initial render.
    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<SuspenseObserver />}>{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // wait for Suspense to resolve
    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(testMessages));

    // the component fetches the initial messages and suspends on first render
    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(suspenseRendered).toHaveBeenCalled();

    // reset our Suspense observer
    suspenseRendered.mockClear();

    await screen.rerender(<TestComponent />);

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(testMessages));

    // since the initial messages are cached, the getInitialMessages function is not called again
    // and the component does not suspend
    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(suspenseRendered).not.toHaveBeenCalled();
  });
});
