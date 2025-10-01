import { StrictMode, Suspense, act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { useAgentChat } from "../ai-react";
import type { useAgent } from "../react";

// Store the mock implementation so we can reset it between tests
let useChatMock = vi.fn();

// mock the @ai-sdk/react package
vi.mock("@ai-sdk/react", () => ({
  useChat: (...args: unknown[]) => useChatMock(...args)
}));

beforeEach(() => {
  useChatMock = vi.fn((args) => ({
    messages: args.messages || [],
    setMessages: vi.fn(),
    append: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    isLoading: false,
    error: undefined
  }));
});

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
      agent: "Chat",
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
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
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

  it("should refetch initial messages when the agent name changes", async () => {
    // This test verifies the fix for issue #420
    // https://github.com/cloudflare/agents/issues/420

    const mockAgent1: ReturnType<typeof useAgent> = {
      _pkurl: "ws://localhost:3000",
      _url: "ws://localhost:3000",
      addEventListener: vi.fn(),
      agent: "Chat",
      id: "agent-1",
      name: "thread-1",
      removeEventListener: vi.fn(),
      send: vi.fn()
      // biome-ignore lint/suspicious/noExplicitAny: tests
    } as any;

    const mockAgent2: ReturnType<typeof useAgent> = {
      _pkurl: "ws://localhost:3000",
      _url: "ws://localhost:3000",
      addEventListener: vi.fn(),
      agent: "Chat",
      id: "agent-2",
      name: "thread-2",
      removeEventListener: vi.fn(),
      send: vi.fn()
      // biome-ignore lint/suspicious/noExplicitAny: tests
    } as any;

    const messagesForAgent1 = [
      {
        id: "1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Hi from thread 1" }]
      },
      {
        id: "2",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Hello from thread 1" }]
      }
    ];

    const messagesForAgent2 = [
      {
        id: "3",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Hi from thread 2" }]
      },
      {
        id: "4",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Hello from thread 2" }]
      }
    ];

    const getInitialMessages = vi.fn(
      (options: { agent: string | undefined; name: string; url: string }) => {
        if (options.name === "thread-1") {
          return Promise.resolve(messagesForAgent1);
        }
        return Promise.resolve(messagesForAgent2);
      }
    );

    const TestComponent = ({
      agent
    }: {
      agent: ReturnType<typeof useAgent>;
    }) => {
      const chat = useAgentChat({
        agent,
        getInitialMessages
      });

      // NOTE: this only works because of how @ai-sdk/react is mocked to use
      // the initialMessages prop as the messages state in the mock return value.
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
    };

    // wrapping in act is required to resolve the suspense boundary during
    // initial render.
    const screen = await act(() =>
      render(<TestComponent agent={mockAgent1} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Wait for initial messages from agent 1
    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(messagesForAgent1));

    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(getInitialMessages).toHaveBeenCalledWith({
      agent: "Chat",
      name: "thread-1",
      url: expect.stringContaining("http://localhost:3000")
    });

    // Switch to agent 2
    await act(() => screen.rerender(<TestComponent agent={mockAgent2} />));

    // Messages should update to agent 2's messages
    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(messagesForAgent2));

    // getInitialMessages should be called again for the new agent
    expect(getInitialMessages).toHaveBeenCalledTimes(2);
    expect(getInitialMessages).toHaveBeenCalledWith({
      agent: "Chat",
      name: "thread-2",
      url: expect.stringContaining("http://localhost:3000")
    });
  });

  it("should update messages when switching agents after messages have been appended", async () => {
    // This test verifies the specific bug scenario from issue #420
    // where messages don't update after the first agent receives new messages
    // https://github.com/cloudflare/agents/issues/420

    const mockAgent1: ReturnType<typeof useAgent> = {
      _pkurl: "ws://localhost:3000",
      _url: "ws://localhost:3000",
      addEventListener: vi.fn(),
      agent: "Chat",
      id: "agent-1",
      name: "thread-1",
      removeEventListener: vi.fn(),
      send: vi.fn()
      // biome-ignore lint/suspicious/noExplicitAny: tests
    } as any;

    const mockAgent2: ReturnType<typeof useAgent> = {
      _pkurl: "ws://localhost:3000",
      _url: "ws://localhost:3000",
      addEventListener: vi.fn(),
      agent: "Chat",
      id: "agent-2",
      name: "thread-2",
      removeEventListener: vi.fn(),
      send: vi.fn()
      // biome-ignore lint/suspicious/noExplicitAny: tests
    } as any;

    const initialMessagesForAgent1 = [
      {
        id: "1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Initial message" }]
      }
    ];

    const messagesForAgent2 = [
      {
        id: "3",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Thread 2 message" }]
      }
    ];

    const getInitialMessages = vi.fn(
      (options: { agent: string | undefined; name: string; url: string }) => {
        if (options.name === "thread-1") {
          return Promise.resolve(initialMessagesForAgent1);
        }
        return Promise.resolve(messagesForAgent2);
      }
    );

    const TestComponent = ({
      agent
    }: {
      agent: ReturnType<typeof useAgent>;
    }) => {
      const chat = useAgentChat({
        agent,
        getInitialMessages
      });

      return (
        <div>
          <div data-testid="messages">{JSON.stringify(chat.messages)}</div>
          <div data-testid="agent-name">{agent.name}</div>
        </div>
      );
    };

    const screen = await act(() =>
      render(<TestComponent agent={mockAgent1} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Wait for initial render with agent 1
    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(initialMessagesForAgent1));

    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    // Now switch to agent 2
    await act(() => screen.rerender(<TestComponent agent={mockAgent2} />));

    await expect
      .element(screen.getByTestId("agent-name"))
      .toHaveTextContent("thread-2");

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(messagesForAgent2));

    // getInitialMessages should be called for both agents
    expect(getInitialMessages).toHaveBeenCalledTimes(2);
    expect(getInitialMessages).toHaveBeenNthCalledWith(2, {
      agent: "Chat",
      name: "thread-2",
      url: expect.stringContaining("http://localhost:3000")
    });
  });
});
