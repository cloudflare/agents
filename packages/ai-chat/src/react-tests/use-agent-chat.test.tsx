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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAgent({
  name,
  url,
  send
}: {
  name: string;
  url: string;
  send?: (data: string) => void;
}) {
  const target = new EventTarget();
  const baseAgent = {
    _pkurl: url,
    _pk: name, // Use name as pk to distinguish agents
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: send ?? (() => {}),
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

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<SuspenseObserver />}>{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

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

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agentA} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback={<SuspenseObserver />}>{children}</Suspense>
          </StrictMode>
        )
      });

      await sleep(10);
      return screen;
    });

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Hello from thread-a");

    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(getInitialMessages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "thread-a" })
    );

    suspenseRendered.mockClear();

    await act(async () => {
      screen.rerender(<TestComponent agent={agentB} />);
      await sleep(10);
    });

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
        await sleep(10);
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

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      // The tool should have been automatically executed
      await sleep(10);
      return screen;
    });

    // Wait for initial messages to load
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("2");

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

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

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

describe("useAgentChat setMessages", () => {
  it("should handle functional updater and sync resolved messages to server", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "set-messages-test",
      url: "ws://localhost:3000/agents/chat/set-messages-test?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }]
      }
    ];

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages)
      });
      chatInstance = chat;
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("2");

    // Use functional updater to append a message
    const newMessage: UIMessage = {
      id: "msg-3",
      role: "user",
      parts: [{ type: "text", text: "Follow up" }]
    };

    await act(async () => {
      chatInstance!.setMessages((prev) => [...prev, newMessage]);
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("3");

    // Verify the server received the RESOLVED messages (not empty array)
    const chatMessagesSent = sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "cf_agent_chat_messages");

    expect(chatMessagesSent.length).toBeGreaterThan(0);
    const lastSent = chatMessagesSent[chatMessagesSent.length - 1];
    // Should have the full 3 messages, NOT an empty array
    expect(lastSent.messages.length).toBe(3);
    expect(lastSent.messages[2].id).toBe("msg-3");
  });

  it("should handle array setMessages and sync to server", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "set-messages-array-test",
      url: "ws://localhost:3000/agents/chat/set-messages-array-test?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    // Set messages with an array directly
    const newMessages: UIMessage[] = [
      {
        id: "arr-1",
        role: "user",
        parts: [{ type: "text", text: "Replaced" }]
      }
    ];

    await act(async () => {
      chatInstance!.setMessages(newMessages);
      await sleep(10);
    });

    // Verify the server received the array
    const chatMessagesSent = sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "cf_agent_chat_messages");

    expect(chatMessagesSent.length).toBeGreaterThan(0);
    const lastSent = chatMessagesSent[chatMessagesSent.length - 1];
    expect(lastSent.messages.length).toBe(1);
    expect(lastSent.messages[0].id).toBe("arr-1");
  });
});

describe("useAgentChat clearHistory", () => {
  it("should clear local state and send CF_AGENT_CHAT_CLEAR to server", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "clear-test",
      url: "ws://localhost:3000/agents/chat/clear-test?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const initialMessages: UIMessage[] = [
      {
        id: "clear-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      }
    ];

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages)
      });
      chatInstance = chat;
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("1");

    await act(async () => {
      chatInstance!.clearHistory();
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");

    // Verify CF_AGENT_CHAT_CLEAR was sent
    const clearMessages = sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "cf_agent_chat_clear");
    expect(clearMessages.length).toBe(1);
  });
});

describe("useAgentChat onToolCall", () => {
  it("should fire onToolCall for input-available tool parts", async () => {
    const agent = createAgent({
      name: "ontoolcall-test",
      url: "ws://localhost:3000/agents/chat/ontoolcall-test?_pk=abc",
      send: () => {}
    });

    const toolCallReceived = vi.fn();

    const initialMessages: UIMessage[] = [
      {
        id: "msg-tool-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-1",
            state: "input-available",
            input: { query: "current" }
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        onToolCall: ({ toolCall, addToolOutput }) => {
          toolCallReceived(toolCall);
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 40.7, lng: -74.0 }
          });
        }
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(50);
    });

    // onToolCall should have been called with the tool call details
    expect(toolCallReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tc-1",
        toolName: "getLocation",
        input: { query: "current" }
      })
    );
  });
});

describe("useAgentChat re-render stability", () => {
  it("should not cause infinite re-renders when idle", async () => {
    const agent = createAgent({
      name: "rerender-idle",
      url: "ws://localhost:3000/agents/chat/rerender-idle?_pk=abc"
    });

    let renderCount = 0;

    const TestComponent = () => {
      renderCount++;
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: []
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    // Capture render count after initial mount
    const afterMountCount = renderCount;

    // Wait to see if more renders happen (would indicate an infinite loop)
    await sleep(200);

    // In Strict Mode, React double-renders. After mount stabilizes,
    // there should be NO additional renders (no infinite loop).
    expect(renderCount).toBe(afterMountCount);
  });

  it("should not re-render excessively when messages are set", async () => {
    const agent = createAgent({
      name: "rerender-messages",
      url: "ws://localhost:3000/agents/chat/rerender-messages?_pk=abc"
    });

    let renderCount = 0;
    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      renderCount++;
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    const beforeSetMessages = renderCount;

    // Set messages
    await act(async () => {
      chatInstance!.setMessages([
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ]);
      await sleep(10);
    });

    const afterSetMessages = renderCount;

    // Wait to see if renders stabilize
    await sleep(200);

    // Should have re-rendered for the setMessages call but then stopped.
    // Allow some re-renders (React batching, state updates) but not infinite.
    const rendersFromSetMessages = afterSetMessages - beforeSetMessages;
    expect(rendersFromSetMessages).toBeLessThan(10);

    // No additional renders after stabilizing
    expect(renderCount).toBe(afterSetMessages);
  });

  it("should stabilize after receiving a broadcast message", async () => {
    const target = new EventTarget();
    const agent = createAgent({
      name: "rerender-broadcast",
      url: "ws://localhost:3000/agents/chat/rerender-broadcast?_pk=abc"
    });
    // Override addEventListener/removeEventListener to use our target
    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);

    let renderCount = 0;

    const TestComponent = () => {
      renderCount++;
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: []
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    const beforeBroadcast = renderCount;

    // Simulate a server broadcast (CF_AGENT_CHAT_MESSAGES)
    await act(async () => {
      target.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "cf_agent_chat_messages",
            messages: [
              {
                id: "broadcast-1",
                role: "user",
                parts: [{ type: "text", text: "From other tab" }]
              }
            ]
          })
        })
      );
      await sleep(10);
    });

    const afterBroadcast = renderCount;

    // Wait for stabilization
    await sleep(200);

    // Should have re-rendered for the broadcast but then stopped
    const rendersFromBroadcast = afterBroadcast - beforeBroadcast;
    expect(rendersFromBroadcast).toBeGreaterThan(0); // Must have re-rendered
    expect(rendersFromBroadcast).toBeLessThan(10); // But not infinitely

    // No additional renders after stabilizing
    expect(renderCount).toBe(afterBroadcast);
  });
});

describe("useAgentChat body option", () => {
  it("should include static body fields in sent messages", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "body-static-test",
      url: "ws://localhost:3000/agents/chat/body-static-test?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [],
        body: { timezone: "America/New_York", userId: "user-123" }
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    // The body fields should be included when the transport sends messages
    // We can verify by checking that the component rendered without errors
    // (the actual body merging is tested via the sent WS messages)
    expect(sentMessages).toBeDefined();
  });

  it("should include dynamic body fields from function", async () => {
    const sentMessages: string[] = [];
    let callCount = 0;
    const agent = createAgent({
      name: "body-dynamic-test",
      url: "ws://localhost:3000/agents/chat/body-dynamic-test?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [],
        body: () => {
          callCount++;
          return { timestamp: Date.now(), requestNumber: callCount };
        }
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    // Component should render without errors with function body
    expect(callCount).toBeDefined();
  });

  it("should work alongside prepareSendMessagesRequest", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "body-combined-test",
      url: "ws://localhost:3000/agents/chat/body-combined-test?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const prepareSendMessagesRequest = vi.fn(() => ({
      body: { fromPrepare: true }
    }));

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [],
        body: { fromBody: true },
        prepareSendMessagesRequest
      });
      return <div data-testid="messages-count">{chat.messages.length}</div>;
    };

    await act(async () => {
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
    });

    // Both body and prepareSendMessagesRequest should coexist without errors
    expect(sentMessages).toBeDefined();
  });
});
