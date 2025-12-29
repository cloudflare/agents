import { StrictMode, Suspense, act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UIMessage } from "ai";
import {
  useAgentChat,
  type PrepareSendMessagesRequestOptions,
  type PrepareSendMessagesRequestResult,
  type AITool
} from "../react";
import type { useAgent } from "agents/react";

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

  it("should auto-extract schemas from tools with execute functions", async () => {
    const agent = createAgent({
      name: "thread-client-tools",
      url: "ws://localhost:3000/agents/chat/thread-client-tools?_pk=abc"
    });

    // Tools with execute functions have their schemas auto-extracted and sent to server
    const tools: Record<string, AITool<unknown, unknown>> = {
      showAlert: {
        description: "Shows an alert dialog to the user",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "The message to display" }
          },
          required: ["message"]
        },
        execute: async (input) => {
          // Client-side execution
          const { message } = input as { message: string };
          return { shown: true, message };
        }
      },
      changeBackgroundColor: {
        description: "Changes the page background color",
        parameters: {
          type: "object",
          properties: {
            color: { type: "string" }
          }
        },
        execute: async (input) => {
          const { color } = input as { color: string };
          return { success: true, color };
        }
      }
    };

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        tools
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

  it("should combine auto-extracted tools with prepareSendMessagesRequest", async () => {
    const agent = createAgent({
      name: "thread-combined",
      url: "ws://localhost:3000/agents/chat/thread-combined?_pk=abc"
    });

    const tools: Record<string, AITool> = {
      showAlert: {
        description: "Shows an alert",
        execute: async () => ({ shown: true })
      }
    };

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
        tools,
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

  it("should work with tools that have execute functions for client-side execution", async () => {
    const agent = createAgent({
      name: "thread-tools-execution",
      url: "ws://localhost:3000/agents/chat/thread-tools-execution?_pk=abc"
    });

    const mockExecute = vi.fn().mockResolvedValue({ success: true });

    // Single unified tools object - schema + execute in one place
    const tools: Record<string, AITool> = {
      showAlert: {
        description: "Shows an alert",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } }
        },
        execute: mockExecute
      }
    };

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        tools
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

describe("useAgentChat client-side tool execution (issue #728)", () => {
  it("should update tool part state from input-available to output-available when addToolResult is called", async () => {
    const agent = createAgent({
      name: "tool-state-test",
      url: "ws://localhost:3000/agents/chat/tool-state-test?_pk=abc"
    });

    const mockExecute = vi.fn().mockResolvedValue({ location: "New York" });

    // Initial messages with a tool call in input-available state
    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Where am I?" }]
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tool-call-1",
            state: "input-available",
            input: {}
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        experimental_automaticToolResolution: true,
        tools: {
          getLocation: {
            execute: mockExecute
          }
        }
      });

      // Find the tool part to check its state
      const assistantMsg = chat.messages.find((m) => m.role === "assistant");
      const toolPart = assistantMsg?.parts.find(
        (p) => "toolCallId" in p && p.toolCallId === "tool-call-1"
      );
      const toolState =
        toolPart && "state" in toolPart ? toolPart.state : "not-found";

      return (
        <div>
          <div data-testid="messages-count">{chat.messages.length}</div>
          <div data-testid="tool-state">{toolState}</div>
        </div>
      );
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

    // Wait for initial messages to load
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("2");

    // The tool should have been automatically executed
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Verify the tool execute was called
    expect(mockExecute).toHaveBeenCalled();

    // the tool part should be updated to output-available
    // in the SAME message (msg-2), not in a new message
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("2"); // Should still be 2 messages, not 3

    // The tool state should be output-available after addToolResult
    await expect
      .element(screen.getByTestId("tool-state"))
      .toHaveTextContent("output-available");
  });

  it("should not create duplicate tool parts when client executes tool", async () => {
    const agent = createAgent({
      name: "duplicate-test",
      url: "ws://localhost:3000/agents/chat/duplicate-test?_pk=abc"
    });

    const mockExecute = vi.fn().mockResolvedValue({ confirmed: true });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Should I proceed?" },
          {
            type: "tool-askForConfirmation",
            toolCallId: "confirm-1",
            state: "input-available",
            input: { message: "Proceed with action?" }
          }
        ]
      }
    ];

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        tools: {
          askForConfirmation: {
            execute: mockExecute
          }
        }
      });
      chatInstance = chat;

      // Count tool parts with this toolCallId
      const toolPartsCount = chat.messages.reduce((count, msg) => {
        return (
          count +
          msg.parts.filter(
            (p) => "toolCallId" in p && p.toolCallId === "confirm-1"
          ).length
        );
      }, 0);

      // Get the tool state
      const toolPart = chat.messages
        .flatMap((m) => m.parts)
        .find((p) => "toolCallId" in p && p.toolCallId === "confirm-1");
      const toolState =
        toolPart && "state" in toolPart ? toolPart.state : "not-found";

      return (
        <div>
          <div data-testid="messages-count">{chat.messages.length}</div>
          <div data-testid="tool-parts-count">{toolPartsCount}</div>
          <div data-testid="tool-state">{toolState}</div>
        </div>
      );
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

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("1");

    // Manually trigger addToolResult to simulate user confirming
    await act(async () => {
      if (chatInstance) {
        await chatInstance.addToolResult({
          tool: "askForConfirmation",
          toolCallId: "confirm-1",
          output: { confirmed: true }
        });
      }
    });

    // There should still be exactly ONE tool part with this toolCallId
    await expect
      .element(screen.getByTestId("tool-parts-count"))
      .toHaveTextContent("1");

    // The tool state should be updated to output-available
    await expect
      .element(screen.getByTestId("tool-state"))
      .toHaveTextContent("output-available");
  });
});
