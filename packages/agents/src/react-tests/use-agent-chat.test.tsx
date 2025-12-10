import { StrictMode, Suspense, act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UIMessage } from "ai";
import {
  useAgentChat,
  type PrepareSendMessagesRequestOptions,
  type PrepareSendMessagesRequestResult,
  type ClientTool
} from "../ai-react";
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

  it("should accept prepareSendMessagesRequest option without errors", async () => {
    const agent = createAgent({
      name: "thread-with-tools",
      url: "ws://localhost:3000/agents/chat/thread-with-tools?_pk=abc"
    });

    const prepareSendMessagesRequest = vi.fn(
      (
        _options: PrepareSendMessagesRequestOptions<UIMessage>
      ): PrepareSendMessagesRequestResult => ({
        body: {
          clientTools: [
            {
              name: "showAlert",
              description: "Shows an alert to the user",
              parameters: { message: { type: "string" } }
            }
          ]
        },
        headers: {
          "X-Client-Tool-Count": "1"
        }
      })
    );

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null, // Skip fetching initial messages
        prepareSendMessagesRequest
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Verify component renders without errors
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
  });

  it("should handle async prepareSendMessagesRequest", async () => {
    const agent = createAgent({
      name: "thread-async-prepare",
      url: "ws://localhost:3000/agents/chat/thread-async-prepare?_pk=abc"
    });

    const prepareSendMessagesRequest = vi.fn(
      async (
        _options: PrepareSendMessagesRequestOptions<UIMessage>
      ): Promise<PrepareSendMessagesRequestResult> => {
        // Simulate async operation like fetching tool definitions
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          body: {
            clientTools: [
              { name: "navigateToPage", description: "Navigates to a page" }
            ]
          }
        };
      }
    );

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        prepareSendMessagesRequest
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Verify component renders without errors
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
  });

  it("should accept clientTools option (simple API)", async () => {
    const agent = createAgent({
      name: "thread-client-tools",
      url: "ws://localhost:3000/agents/chat/thread-client-tools?_pk=abc"
    });

    const clientTools: ClientTool[] = [
      {
        name: "showAlert",
        description: "Shows an alert dialog to the user",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "The message to display" }
          },
          required: ["message"]
        }
      },
      {
        name: "changeBackgroundColor",
        description: "Changes the page background color",
        parameters: {
          type: "object",
          properties: {
            color: { type: "string" }
          }
        }
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        clientTools
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Verify component renders without errors
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
  });

  it("should combine clientTools with prepareSendMessagesRequest", async () => {
    const agent = createAgent({
      name: "thread-combined",
      url: "ws://localhost:3000/agents/chat/thread-combined?_pk=abc"
    });

    const clientTools: ClientTool[] = [
      {
        name: "showAlert",
        description: "Shows an alert"
      }
    ];

    const prepareSendMessagesRequest = vi.fn(
      (
        _options: PrepareSendMessagesRequestOptions<UIMessage>
      ): PrepareSendMessagesRequestResult => ({
        body: {
          customData: "extra-context",
          userTimezone: "America/New_York"
        },
        headers: {
          "X-Custom-Header": "custom-value"
        }
      })
    );

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        clientTools,
        prepareSendMessagesRequest
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Verify component renders without errors
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
  });

  it("should work with clientTools and client-side tool execution", async () => {
    const agent = createAgent({
      name: "thread-tools-execution",
      url: "ws://localhost:3000/agents/chat/thread-tools-execution?_pk=abc"
    });

    const clientTools: ClientTool[] = [
      {
        name: "showAlert",
        description: "Shows an alert"
      }
    ];

    const mockExecute = vi.fn().mockResolvedValue({ success: true });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        clientTools,
        tools: {
          showAlert: {
            description: "Shows an alert",
            execute: mockExecute
          }
        }
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(() =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      })
    );

    // Verify component renders without errors
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
  });
});

// Note: Integration tests that verify actual request payload behavior
// would require mocking DefaultChatTransport, which isn't possible in
// browser ESM tests. Such tests should be added to the workers test suite
// or run in a Node.js environment where module mocking is supported.
