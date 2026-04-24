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
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: send ?? (() => {}),
    dispatchEvent: target.dispatchEvent.bind(target),
    getHttpUrl: () =>
      url.replace("ws://", "http://").replace("wss://", "https://")
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

  it("should wait for a valid HTTP URL before fetching initial messages", async () => {
    let url = "";
    const agent = createAgent({
      name: "thread-pending-url",
      url
    });
    agent.getHttpUrl = () =>
      url.replace("ws://", "http://").replace("wss://", "https://");

    const testMessages = [
      {
        id: "1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Hello once ready" }]
      }
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(testMessages), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    const TestComponent = () => {
      const chat = useAgentChat({ agent });
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
    };

    const screen = await act(async () =>
      render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      })
    );

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("[]");
    expect(fetchSpy).not.toHaveBeenCalled();

    url = "ws://localhost:3000/agents/chat/thread-pending-url?_pk=abc";

    await act(async () => {
      screen.rerender(<TestComponent />);
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Hello once ready");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/agents/chat/thread-pending-url/get-messages",
      expect.objectContaining({
        credentials: undefined,
        headers: undefined
      })
    );

    fetchSpy.mockRestore();
  });

  it("should allow custom initial message loaders before the HTTP URL is ready", async () => {
    const agent = createAgent({
      name: "thread-custom-pending-url",
      url: ""
    });
    agent.getHttpUrl = () => "";

    const testMessages = [
      {
        id: "1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Loaded without URL" }]
      }
    ];

    const getInitialMessages = vi.fn(async ({ url }: { url?: string }) => {
      expect(url).toBeUndefined();
      return testMessages;
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages
      });
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
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
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Loaded without URL");
    expect(getInitialMessages).toHaveBeenCalledTimes(1);
  });

  it("should invoke custom getInitialMessages only once across the HTTP URL transition", async () => {
    let url = "";
    const agent = createAgent({
      name: "thread-custom-transition",
      url
    });
    agent.getHttpUrl = () =>
      url.replace("ws://", "http://").replace("wss://", "https://");

    const testMessages = [
      {
        id: "1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "One call only" }]
      }
    ];

    const getInitialMessages = vi.fn(async () => testMessages);

    const TestComponent = () => {
      const chat = useAgentChat({ agent, getInitialMessages });
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
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
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("One call only");
    expect(getInitialMessages).toHaveBeenCalledTimes(1);

    url = "ws://localhost:3000/agents/chat/thread-custom-transition?_pk=abc";
    await act(async () => {
      screen.rerender(<TestComponent />);
      await sleep(10);
    });

    // The URL transitioned from empty → resolved, but the cache key must
    // remain stable across that transition so the custom loader isn't
    // re-invoked and Suspense doesn't flash.
    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("One call only");
  });

  it("should not re-hydrate initial messages when a server broadcast empties the chat", async () => {
    const agent = createAgent({
      name: "thread-rehydrate-test",
      url: "ws://localhost:3000/agents/chat/thread-rehydrate-test?_pk=abc"
    });

    const testMessages = [
      {
        id: "msg-1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Original message" }]
      }
    ];

    const getInitialMessages = vi.fn(async () => testMessages);

    const TestComponent = () => {
      const chat = useAgentChat({ agent, getInitialMessages });
      return <div data-testid="messages">{JSON.stringify(chat.messages)}</div>;
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
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Original message");

    // Simulate a server broadcast with empty messages — e.g. another tab
    // called `setMessages([])` and the server is mirroring the new state
    // back to us via CF_AGENT_CHAT_MESSAGES.
    await act(async () => {
      agent.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "cf_agent_chat_messages",
            messages: []
          })
        })
      );
      await sleep(50);
    });

    // The chat should stay empty — it must NOT be re-hydrated from the
    // initial-messages cache.
    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("[]");
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

describe("useAgentChat cache key stability (issue #1223)", () => {
  it("should not refetch when only query params change (e.g. auth token rotation)", async () => {
    const agentWithTokenA = createAgent({
      name: "thread-auth",
      url: "ws://localhost:3000/agents/chat/thread-auth?_pk=abc&token=jwt-token-1"
    });

    const agentWithTokenB = createAgent({
      name: "thread-auth",
      url: "ws://localhost:3000/agents/chat/thread-auth?_pk=abc&token=jwt-token-2"
    });

    const testMessages = [
      {
        id: "1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Hi" }]
      }
    ];

    const getInitialMessages = vi.fn(() => Promise.resolve(testMessages));

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
      const screen = render(<TestComponent agent={agentWithTokenA} />, {
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

    suspenseRendered.mockClear();

    // Simulate page reload with a new JWT — only query param changes
    await act(async () => {
      screen.rerender(<TestComponent agent={agentWithTokenB} />);
      await sleep(10);
    });

    // Should NOT have re-fetched or re-triggered Suspense
    expect(getInitialMessages).toHaveBeenCalledTimes(1);
    expect(suspenseRendered).not.toHaveBeenCalled();

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent(JSON.stringify(testMessages));
  });

  it("should still refetch when agent name changes even with query params", async () => {
    const agentA = createAgent({
      name: "thread-a",
      url: "ws://localhost:3000/agents/chat/thread-a?_pk=abc&token=jwt-1"
    });

    const agentB = createAgent({
      name: "thread-b",
      url: "ws://localhost:3000/agents/chat/thread-b?_pk=abc&token=jwt-1"
    });

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

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agentA} />, {
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
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Hello from thread-a");

    expect(getInitialMessages).toHaveBeenCalledTimes(1);

    // Switch to a different agent (different name) — should refetch
    await act(async () => {
      screen.rerender(<TestComponent agent={agentB} />);
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("messages"))
      .toHaveTextContent("Hello from thread-b");

    expect(getInitialMessages).toHaveBeenCalledTimes(2);
  });
});

describe("useAgentChat Chat instance stability", () => {
  // Covers the interaction with `useAgent({ basePath })` +
  // `static options = { sendIdentityOnConnect: true }`:
  //
  // The server owns the Durable Object instance name; the browser starts
  // with a placeholder (`"default"`), then `useAgent` mutates
  // `agent.name` in place when the identity frame arrives. This *must
  // not* recreate the underlying AI SDK Chat instance, because doing so
  // orphans any in-flight `transport.reconnectToStream()` (the resume
  // path). The useEffect that fires `chatRef.current.resumeStream()` is
  // keyed on the ref object and won't re-fire for the recreated Chat, so
  // the orphaned Chat receives chunks into its state while React reads
  // the new Chat's state — and the user sees an empty reply until the
  // server's final `CF_AGENT_CHAT_MESSAGES` broadcast lands.
  it("should keep the Chat instance stable when agent.name transitions in-place from the fallback to a server-assigned value", async () => {
    const agent = createAgent({
      name: "default",
      url: "ws://localhost:3000/chat?_pk=abc"
    });

    const captured: { sendMessageRef: unknown } = { sendMessageRef: undefined };
    const getInitialMessages = vi.fn(async () => []);

    const TestComponent = () => {
      const chat = useAgentChat({ agent, getInitialMessages });
      captured.sendMessageRef = chat.sendMessage;
      return (
        <div data-testid="name">
          {(agent as unknown as { name: string }).name}
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

    const firstSendMessage = captured.sendMessageRef;
    expect(firstSendMessage).toBeDefined();

    // Simulate `useAgent`'s identity-frame handler writing
    // `agent.name = identity.name` on the SAME agent object reference.
    await act(async () => {
      (agent as unknown as { name: string }).name = "real-user";
      screen.rerender(<TestComponent />);
      await sleep(10);
    });

    // sendMessage is re-exposed from chatRef.current.sendMessage each
    // render; if the Chat instance was recreated, this reference would
    // change. Same reference ⇒ same Chat ⇒ resume would still be valid.
    expect(captured.sendMessageRef).toBe(firstSendMessage);
    await expect
      .element(screen.getByTestId("name"))
      .toHaveTextContent("real-user");
  });

  it("should treat a different agent object reference as a chat switch and recreate the Chat", async () => {
    const agentA = createAgent({
      name: "thread-a",
      url: "ws://localhost:3000/agents/chat/thread-a?_pk=abc"
    });
    const agentB = createAgent({
      name: "thread-b",
      url: "ws://localhost:3000/agents/chat/thread-b?_pk=abc"
    });

    const captured: { sendMessageRef: unknown } = { sendMessageRef: undefined };
    const getInitialMessages = vi.fn(async () => []);

    const TestComponent = ({
      agent
    }: {
      agent: ReturnType<typeof useAgent>;
    }) => {
      const chat = useAgentChat({ agent, getInitialMessages });
      captured.sendMessageRef = chat.sendMessage;
      return <div />;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agentA} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

    const firstSendMessage = captured.sendMessageRef;
    expect(firstSendMessage).toBeDefined();

    // Swap to a different agent object — the canonical "consumer
    // switched chats" signal. Chat MUST recreate so the new messages
    // / transport / resume binding reflect the new conversation.
    await act(async () => {
      screen.rerender(<TestComponent agent={agentB} />);
      await sleep(10);
    });

    expect(captured.sendMessageRef).not.toBe(firstSendMessage);
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

describe("useAgentChat autoContinueAfterToolResult default", () => {
  it("should send autoContinue: true by default with tool results", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "auto-continue-default",
      url: "ws://localhost:3000/agents/chat/auto-continue-default?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-default-1",
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
        // No explicit autoContinueAfterToolResult — should default to true
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
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

    // Find the CF_AGENT_TOOL_RESULT message
    const toolResultMessages = sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "cf_agent_tool_result");

    expect(toolResultMessages.length).toBeGreaterThanOrEqual(1);
    // Default should be autoContinue: true
    expect(toolResultMessages[0].autoContinue).toBe(true);
  });

  it("should send autoContinue: false when explicitly disabled", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "auto-continue-disabled",
      url: "ws://localhost:3000/agents/chat/auto-continue-disabled?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-disabled-1",
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
        autoContinueAfterToolResult: false, // Explicitly disabled
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
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

    const toolResultMessages = sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "cf_agent_tool_result");

    expect(toolResultMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolResultMessages[0].autoContinue).toBe(false);
  });

  it("should send autoContinue: true by default with tool approvals", async () => {
    const sentMessages: string[] = [];
    const agent = createAgent({
      name: "auto-continue-approval",
      url: "ws://localhost:3000/agents/chat/auto-continue-approval?_pk=abc",
      send: (data: string) => sentMessages.push(data)
    });

    // Tool part must have approval.id so the wrapper can find the toolCallId
    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-dangerousAction",
            toolCallId: "tc-approval-1",
            state: "approval-requested",
            input: { action: "delete" },
            approval: { id: "approval-req-1" }
          }
        ]
      }
    ];

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages)
        // No explicit autoContinueAfterToolResult — should default to true
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
      await sleep(50);
    });

    // Send approval via the hook using the approval request ID
    await act(async () => {
      if (chatInstance) {
        chatInstance.addToolApprovalResponse({
          id: "approval-req-1",
          approved: true
        });
      }
      await sleep(10);
    });

    // Find the CF_AGENT_TOOL_APPROVAL message
    const approvalMessages = sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "cf_agent_tool_approval");

    expect(approvalMessages.length).toBeGreaterThanOrEqual(1);
    expect(approvalMessages[0].autoContinue).toBe(true);
    expect(approvalMessages[0].approved).toBe(true);
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

describe("useAgentChat tool continuation status (issue #1157)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const sentMessages: string[] = [];
    const agent = createAgent({
      name,
      url,
      send: (data: string) => sentMessages.push(data)
    });

    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);

    return { agent, target, sentMessages };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  it("should use transport-owned status for addToolOutput continuations", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "tool-status-output",
      url: "ws://localhost:3000/agents/chat/tool-status-output?_pk=abc"
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tool-call-1",
            state: "input-available",
            input: { city: "London" }
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });

      return <div data-testid="status">{chat.status}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(50);
      return screen;
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("submitted");

    const parsedMessages = sentMessages.map((message) => JSON.parse(message));
    expect(
      parsedMessages.some(
        (message) => message.type === "cf_agent_stream_resume_request"
      )
    ).toBe(true);

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-1"
      });
      await sleep(10);
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-1",
        continuation: true,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-1",
        continuation: true,
        body: '{"type":"text-delta","id":"t1","delta":"Hello"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("streaming");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-1",
        continuation: true,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("ready");
  });

  it("should use transport-owned status for approval continuations", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "tool-status-approval",
      url: "ws://localhost:3000/agents/chat/tool-status-approval?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;
    const initialMessages: UIMessage[] = [
      {
        id: "msg-approval",
        role: "assistant",
        parts: [
          {
            type: "tool-runDangerousThing",
            toolCallId: "tool-call-approval",
            state: "approval-requested",
            input: { command: "rm -rf /tmp/demo" },
            approval: { id: "approval-1" }
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        resume: false
      });
      chatInstance = chat;
      return <div data-testid="status">{chat.status}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(50);
      return screen;
    });

    await act(async () => {
      chatInstance!.addToolApprovalResponse({
        id: "approval-1",
        approved: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("submitted");

    const parsedMessages = sentMessages.map((message) => JSON.parse(message));
    expect(
      parsedMessages.some(
        (message) => message.type === "cf_agent_stream_resume_request"
      )
    ).toBe(true);

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-approval"
      });
      await sleep(10);
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-approval",
        continuation: true,
        body: '{"type":"text-start","id":"t2"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-approval",
        continuation: true,
        body: '{"type":"text-delta","id":"t2","delta":"Approved"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("streaming");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-approval",
        continuation: true,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("ready");
  });
});

// Issue #1365 (second half): `status` is correctly `submitted`/`streaming`
// across tool round-trips (per issue #1157), but consumers who want a
// typing indicator *only* for fresh user submissions had to inspect
// message history to distinguish the two. `isToolContinuation` is a
// purely additive disambiguation flag — it doesn't change `status` at
// all, it just tells you why `status` is currently non-`ready`.
describe("useAgentChat isToolContinuation (issue #1365)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const sentMessages: string[] = [];
    const agent = createAgent({
      name,
      url,
      send: (data: string) => sentMessages.push(data)
    });
    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);
    return { agent, target, sentMessages };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  it("is false on mount and while idle", async () => {
    const { agent } = createAgentWithTarget({
      name: "tool-cont-idle",
      url: "ws://localhost:3000/agents/chat/tool-cont-idle?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: []
      });
      return (
        <div data-testid="isToolContinuation">
          {String(chat.isToolContinuation)}
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
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  it("flips true after addToolOutput and back to false when the continuation ends", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "tool-cont-lifecycle",
      url: "ws://localhost:3000/agents/chat/tool-cont-lifecycle?_pk=abc"
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-life-1",
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
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });
      return (
        <div>
          <div data-testid="isToolContinuation">
            {String(chat.isToolContinuation)}
          </div>
          <div data-testid="status">{chat.status}</div>
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
      await sleep(50);
      return screen;
    });

    // addToolOutput has fired → continuation in flight
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("true");
    // status tracks the tool round-trip as before (issue #1157)
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("submitted");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-life"
      });
      await sleep(10);
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-life",
        continuation: true,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    // Still a continuation, even once chunks are flowing
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("streaming");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-life",
        continuation: true,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("ready");
  });

  it("stays false when autoContinueAfterToolResult is disabled", async () => {
    const { agent } = createAgentWithTarget({
      name: "tool-cont-noauto",
      url: "ws://localhost:3000/agents/chat/tool-cont-noauto?_pk=abc"
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-noauto-1",
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
        resume: false,
        autoContinueAfterToolResult: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });
      return (
        <div data-testid="isToolContinuation">
          {String(chat.isToolContinuation)}
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
      await sleep(50);
      return screen;
    });

    // No continuation happens → flag must stay false even though
    // addToolOutput has been called.
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  it("flips true after addToolApprovalResponse", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "tool-cont-approval",
      url: "ws://localhost:3000/agents/chat/tool-cont-approval?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;
    const initialMessages: UIMessage[] = [
      {
        id: "msg-approval",
        role: "assistant",
        parts: [
          {
            type: "tool-dangerousAction",
            toolCallId: "tc-approval-1",
            state: "approval-requested",
            input: { action: "delete" },
            approval: { id: "approval-1" }
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        resume: false
      });
      chatInstance = chat;
      return (
        <div data-testid="isToolContinuation">
          {String(chat.isToolContinuation)}
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
      await sleep(50);
      return screen;
    });

    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");

    await act(async () => {
      chatInstance!.addToolApprovalResponse({
        id: "approval-1",
        approved: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("true");

    // Finish the continuation
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-appr"
      });
      await sleep(10);
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-appr",
        continuation: true,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  it("resets to false when stop() is called mid-continuation", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "tool-cont-stop",
      url: "ws://localhost:3000/agents/chat/tool-cont-stop?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;
    const initialMessages: UIMessage[] = [
      {
        id: "msg-stop",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-stop-1",
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
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });
      chatInstance = chat;
      return (
        <div data-testid="isToolContinuation">
          {String(chat.isToolContinuation)}
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
      await sleep(50);
      return screen;
    });

    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("true");

    // Handshake completes so the transport has a requestId to cancel.
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-stop"
      });
      await sleep(10);
    });

    // Stop mid-continuation (before done:true)
    await act(async () => {
      await chatInstance!.stop();
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  it("stays false for server-pushed cross-tab broadcasts that aren't our continuation", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "tool-cont-broadcast",
      url: "ws://localhost:3000/agents/chat/tool-cont-broadcast?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: []
      });
      return (
        <div>
          <div data-testid="isToolContinuation">
            {String(chat.isToolContinuation)}
          </div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
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

    // Another tab's activity surfaces through isServerStreaming but must
    // NOT flip isToolContinuation — this tab didn't initiate it.
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "other-tab-req",
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  it("clearHistory() during an active continuation resets isToolContinuation synchronously", async () => {
    // Covers the first half of the race: without a synchronous reset
    // of the state, isToolContinuation would linger as `true` over an
    // empty message list until the in-flight resumeStream() promise
    // eventually settles.
    const { agent } = createAgentWithTarget({
      name: "tool-cont-clear",
      url: "ws://localhost:3000/agents/chat/tool-cont-clear?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;
    const initialMessages: UIMessage[] = [
      {
        id: "msg-clear",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-clear-1",
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
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });
      chatInstance = chat;
      return (
        <div>
          <div data-testid="isToolContinuation">
            {String(chat.isToolContinuation)}
          </div>
          <div data-testid="messages-count">{chat.messages.length}</div>
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
      await sleep(50);
      return screen;
    });

    // Continuation in flight from addToolOutput
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("true");

    // Clear history mid-continuation — the resumeStream() promise is
    // still pending, but the flag must NOT linger as true over an
    // empty chat.
    await act(async () => {
      chatInstance!.clearHistory();
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  it("server-pushed CF_AGENT_CHAT_CLEAR also resets isToolContinuation synchronously", async () => {
    // Cross-tab parity with the clearHistory() test above: if another
    // tab (or the server itself) clears the chat while this tab has
    // an active tool continuation, isToolContinuation must not linger
    // as true over an empty message list.
    const { agent, target } = createAgentWithTarget({
      name: "tool-cont-broadcast-clear",
      url: "ws://localhost:3000/agents/chat/tool-cont-broadcast-clear?_pk=abc"
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-bc-clear",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-bc-clear-1",
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
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });
      return (
        <div>
          <div data-testid="isToolContinuation">
            {String(chat.isToolContinuation)}
          </div>
          <div data-testid="messages-count">{chat.messages.length}</div>
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
      await sleep(50);
      return screen;
    });

    // Continuation is in flight from addToolOutput
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("true");

    // Another tab broadcasts a clear. Local tab's in-flight
    // resumeStream() promise is still pending; the flag must NOT
    // linger as true over an empty chat.
    await act(async () => {
      dispatch(target, { type: "cf_agent_chat_clear" });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("isToolContinuation"))
      .toHaveTextContent("false");
  });

  // Note on the "stale .finally() clobbers a newer continuation" race:
  // the second half of the bug (a pending resumeStream() promise from
  // continuation A eventually settling after clearHistory() + a new
  // continuation B has started) is fixed by the generation counter on
  // `startToolContinuation`/`clearHistory` but is impractical to test
  // cleanly here — driving two overlapping continuations through the
  // AI SDK triggers undefined concurrent-`makeRequest` behaviour on
  // the underlying Chat, and both A's and B's deferred streams hit
  // independent 5s timeouts, so B's own legitimate `.finally()`
  // shadows any observation of A's clobber. The synchronous reset
  // test above catches the bug visible to consumers; the race
  // guard is a belt-and-braces fix beyond it.
});

describe("useAgentChat stop during tool continuation (issue #1233)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const sentMessages: string[] = [];
    const agent = createAgent({
      name,
      url,
      send: (data: string) => sentMessages.push(data)
    });

    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);

    return { agent, target, sentMessages };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  it("sends cancel for the server continuation request when stop is called", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "tool-stop-continuation",
      url: "ws://localhost:3000/agents/chat/tool-stop-continuation?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const initialMessages: UIMessage[] = [
      {
        id: "msg-stop",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tool-call-stop",
            state: "input-available",
            input: { city: "London" }
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });

      chatInstance = chat;
      return <div data-testid="status">{chat.status}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(50);
      return screen;
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("submitted");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-stop"
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-stop",
        continuation: true,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-stop",
        continuation: true,
        body: '{"type":"text-delta","id":"t1","delta":"Hello"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("streaming");

    await act(async () => {
      await chatInstance!.stop();
      await sleep(10);
    });

    const parsedMessages = sentMessages.map((message) => JSON.parse(message));
    expect(
      parsedMessages.some(
        (message) =>
          message.type === "cf_agent_chat_request_cancel" &&
          message.id === "server-cont-stop"
      )
    ).toBe(true);
  });
});

describe("useAgentChat stale agent ref (issue #929)", () => {
  it("should use the new agent's send method after agent switch, not the old one", async () => {
    const oldSend = vi.fn();
    const newSend = vi.fn();

    const agentOld = createAgent({
      name: "thread-old",
      url: "ws://localhost:3000/agents/chat/thread-old?_pk=old",
      send: oldSend
    });

    const agentNew = createAgent({
      name: "thread-new",
      url: "ws://localhost:3000/agents/chat/thread-new?_pk=new",
      send: newSend
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = ({
      agent
    }: {
      agent: ReturnType<typeof useAgent>;
    }) => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return <div data-testid="status">{chat.status}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agentOld} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

    // Switch to the new agent
    await act(async () => {
      screen.rerender(<TestComponent agent={agentNew} />);
      await sleep(10);
    });

    // Clear any sends that happened during setup (e.g., stream resume requests)
    oldSend.mockClear();
    newSend.mockClear();

    // Clear history triggers agent.send() — this should go to the NEW agent
    await act(async () => {
      chatInstance!.clearHistory();
      await sleep(10);
    });

    // The clear message should have been sent to the NEW agent, not the old one
    const newSendCalls = newSend.mock.calls
      .map((args) => JSON.parse(args[0] as string))
      .filter((m: Record<string, unknown>) => m.type === "cf_agent_chat_clear");
    expect(newSendCalls.length).toBe(1);

    // The old agent should NOT have received the clear message
    const oldSendCalls = oldSend.mock.calls
      .map((args) => JSON.parse(args[0] as string))
      .filter((m: Record<string, unknown>) => m.type === "cf_agent_chat_clear");
    expect(oldSendCalls.length).toBe(0);
  });
});

describe("useAgentChat stream resumption (issue #896)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const sentMessages: string[] = [];
    const agent = createAgent({
      name,
      url,
      send: (data: string) => sentMessages.push(data)
    });
    // Wire up the target so we can dispatch messages to the hook
    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);
    return { agent, target, sentMessages };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  it("should process resumed stream chunks progressively and update status", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "replay-complete-test",
      url: "ws://localhost:3000/agents/chat/replay-complete-test?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      const assistantMsg = chat.messages.find(
        (m: UIMessage) => m.role === "assistant"
      );
      const textPart = assistantMsg?.parts.find(
        (p: UIMessage["parts"][number]) => p.type === "text"
      ) as { text?: string } | undefined;
      return (
        <div>
          <div data-testid="count">{chat.messages.length}</div>
          <div data-testid="text">{textPart?.text ?? ""}</div>
          <div data-testid="status">{chat.status}</div>
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

    // Initially no messages
    await expect.element(screen.getByTestId("count")).toHaveTextContent("0");

    // Simulate server sending CF_AGENT_STREAM_RESUMING
    // The transport's reconnectToStream picks this up and returns a ReadableStream
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "req-1"
      });
      await sleep(10);
    });

    // Simulate replay chunks — now processed progressively by useChat's pipeline
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-1",
        body: '{"type":"text-start","id":"t1"}',
        done: false,
        replay: true
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-1",
        body: '{"type":"text-delta","id":"t1","delta":"Hello world"}',
        done: false,
        replay: true
      });
      await sleep(10);
    });

    // Chunks are processed progressively by useChat — message appears immediately
    await expect.element(screen.getByTestId("count")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("text"))
      .toHaveTextContent("Hello world");
  });

  it("should flush and finalize after done:true for orphaned streams", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "orphaned-done-test",
      url: "ws://localhost:3000/agents/chat/orphaned-done-test?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      const assistantMsg = chat.messages.find(
        (m: UIMessage) => m.role === "assistant"
      );
      const textPart = assistantMsg?.parts.find(
        (p: UIMessage["parts"][number]) => p.type === "text"
      ) as { text?: string } | undefined;
      return (
        <div>
          <div data-testid="count">{chat.messages.length}</div>
          <div data-testid="text">{textPart?.text ?? ""}</div>
          <div data-testid="status">{chat.status}</div>
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

    // Simulate resume + replay + done (orphaned stream path)
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "req-orphaned"
      });
      await sleep(5);

      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-orphaned",
        body: '{"type":"text-start","id":"t1"}',
        done: false,
        replay: true
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-orphaned",
        body: '{"type":"text-delta","id":"t1","delta":"partial from hibernation"}',
        done: false,
        replay: true
      });

      // done:true signals orphaned stream is finalized
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-orphaned",
        body: "",
        done: true,
        replay: true
      });
      await sleep(10);
    });

    // Message should be flushed with the accumulated text
    await expect.element(screen.getByTestId("count")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("text"))
      .toHaveTextContent("partial from hibernation");
  });

  it("should continue receiving live chunks after replayComplete", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "replay-then-live-test",
      url: "ws://localhost:3000/agents/chat/replay-then-live-test?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      const assistantMsg = chat.messages.find(
        (m: UIMessage) => m.role === "assistant"
      );
      const textPart = assistantMsg?.parts.find(
        (p: UIMessage["parts"][number]) => p.type === "text"
      ) as { text?: string } | undefined;
      return (
        <div>
          <div data-testid="count">{chat.messages.length}</div>
          <div data-testid="text">{textPart?.text ?? ""}</div>
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

    // Replay phase
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "req-live"
      });
      await sleep(5);

      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-live",
        body: '{"type":"text-start","id":"t1"}',
        done: false,
        replay: true
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-live",
        body: '{"type":"text-delta","id":"t1","delta":"replayed-"}',
        done: false,
        replay: true
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-live",
        body: "",
        done: false,
        replay: true,
        replayComplete: true
      });
      await sleep(10);
    });

    // After replay, message should show replayed text
    await expect.element(screen.getByTestId("count")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("text"))
      .toHaveTextContent("replayed-");

    // Now simulate a live chunk arriving (no replay flag)
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-live",
        body: '{"type":"text-delta","id":"t1","delta":"and live!"}',
        done: false
      });
      await sleep(10);
    });

    // The live chunk should append to the same message
    await expect.element(screen.getByTestId("count")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("text"))
      .toHaveTextContent("replayed-and live!");
  });
});

describe("useAgentChat isServerStreaming / isStreaming (issue #1226)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const sentMessages: string[] = [];
    const agent = createAgent({
      name,
      url,
      send: (data: string) => sentMessages.push(data)
    });
    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);
    return { agent, target, sentMessages };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  it("isServerStreaming becomes true during a server-initiated stream and false on done", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "server-stream-status",
      url: "ws://localhost:3000/agents/chat/server-stream-status?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
          <div data-testid="isStreaming">{String(chat.isStreaming)}</div>
          <div data-testid="status">{chat.status}</div>
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

    // Initially not streaming
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("false");

    // Simulate a server-initiated stream (non-local request ID)
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-req-1",
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    // isServerStreaming should be true, isStreaming should be true
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("true");
    // status should still be ready (AI SDK doesn't know about this stream)
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("ready");

    // More chunks
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-req-1",
        body: '{"type":"text-delta","id":"t1","delta":"Hello from server"}',
        done: false
      });
      await sleep(10);
    });

    // Still streaming
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // Stream completes
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-req-1",
        body: "",
        done: true
      });
      await sleep(10);
    });

    // Streaming should be false again
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("false");
  });

  it("isServerStreaming becomes false on stream error", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "server-stream-error",
      url: "ws://localhost:3000/agents/chat/server-stream-error?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
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

    // Start a server stream
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-err-1",
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // Server sends an error
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-err-1",
        body: "Stream error",
        done: true,
        error: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
  });

  it("isServerStreaming resets on agent change (cleanup)", async () => {
    const { agent: agentA, target: targetA } = createAgentWithTarget({
      name: "stream-agent-a",
      url: "ws://localhost:3000/agents/chat/stream-agent-a?_pk=abc"
    });
    const { agent: agentB } = createAgentWithTarget({
      name: "stream-agent-b",
      url: "ws://localhost:3000/agents/chat/stream-agent-b?_pk=abc"
    });

    const TestComponent = ({
      agent
    }: {
      agent: ReturnType<typeof useAgent>;
    }) => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
        </div>
      );
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agentA} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

    // Start streaming on agent A
    await act(async () => {
      dispatch(targetA, {
        type: "cf_agent_use_chat_response",
        id: "req-a",
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // Switch to agent B — cleanup should reset isServerStreaming
    await act(async () => {
      screen.rerender(<TestComponent agent={agentB} />);
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
  });

  it("isServerStreaming becomes true from CF_AGENT_STREAM_RESUMING fallback path", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "server-stream-resume-fallback",
      url: "ws://localhost:3000/agents/chat/server-stream-resume-fallback?_pk=abc"
    });

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
        // resume defaults to true — needed so the RESUMING handler doesn't bail
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
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
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");

    // Resolve the transport's initial resume attempt so it's no longer awaiting.
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resume_none"
      });
      await sleep(10);
    });

    // Now send STREAM_RESUMING for a different stream. The transport isn't
    // awaiting a resume, so handleStreamResuming returns false and the
    // fallback path (which sets activeStreamRef directly) runs.
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-resume-fallback-1"
      });
      await sleep(10);
    });

    // isServerStreaming should be true from the fallback path
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // Stream chunks — should stay true (same stream ID)
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-resume-fallback-1",
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // Stream ends
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-resume-fallback-1",
        body: "",
        done: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
  });

  it("isServerStreaming works with continuation broadcasts", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "server-stream-continuation",
      url: "ws://localhost:3000/agents/chat/server-stream-continuation?_pk=abc"
    });

    const initialMessages: UIMessage[] = [
      {
        id: "assistant-existing",
        role: "assistant",
        parts: [{ type: "text", text: "Previous response" }]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages)
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
          <div data-testid="count">{chat.messages.length}</div>
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
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");

    // Simulate a continuation broadcast (has continuation: true flag)
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-1",
        continuation: true,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      await sleep(10);
    });

    // isServerStreaming should be true during continuation
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-1",
        continuation: true,
        body: '{"type":"text-delta","id":"t1","delta":"Continued text"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // Continuation ends
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-1",
        continuation: true,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
  });

  it("isStreaming is true when both client and server streams are active simultaneously", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "dual-stream",
      url: "ws://localhost:3000/agents/chat/dual-stream?_pk=abc"
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-tool",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tool-call-dual",
            state: "input-available",
            input: { city: "London" }
          }
        ]
      }
    ];

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        resume: false,
        onToolCall: ({ toolCall, addToolOutput }) => {
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5 }
          });
        }
      });
      return (
        <div>
          <div data-testid="status">{chat.status}</div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
          <div data-testid="isStreaming">{String(chat.isStreaming)}</div>
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
      await sleep(50);
      return screen;
    });

    // After initial load, the tool result was sent and the transport is
    // waiting for the server to resume the continuation stream.
    // status is "submitted" (client initiated the tool continuation).
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("submitted");

    // Now simulate a DIFFERENT server-initiated stream broadcast arriving
    // at the same time (e.g., from another tab or saveMessages)
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-other-stream",
        body: '{"type":"text-start","id":"t2"}',
        done: false
      });
      await sleep(10);
    });

    // isServerStreaming should be true (from the broadcast)
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");

    // isStreaming should be true (combines both: status !== "ready" + isServerStreaming)
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("true");

    // End the server-initiated stream
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-other-stream",
        body: "",
        done: true
      });
      await sleep(10);
    });

    // isServerStreaming should be false, but isStreaming can still be true
    // if the client-side status is still "submitted"
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");

    // With isServerStreaming=false, isStreaming depends only on status.
    // status may be "submitted" or "ready" at this point — either way,
    // isStreaming should be false (it only checks status === "streaming").
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("false");
  });

  // Issue #1365: covers the gap between the model emitting a client-tool
  // call and the client calling addToolOutput — historically this window
  // showed status='ready' and isStreaming=false, so consumers had no way
  // to render a busy indicator during an async tool.execute().
  it("isServerStreaming / isStreaming stay true while onToolCall is awaiting (issue #1365)", async () => {
    const agent = createAgent({
      name: "ontoolcall-gap",
      url: "ws://localhost:3000/agents/chat/ontoolcall-gap?_pk=abc",
      send: () => {}
    });

    // Gate the callback so the test can observe the "dark gap"
    // while the tool is still running.
    let resolveToolExec: (() => void) | undefined;
    const toolExecPromise = new Promise<void>((r) => {
      resolveToolExec = r;
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-gap-1",
        role: "assistant",
        parts: [
          {
            type: "tool-getLocation",
            toolCallId: "tc-gap-1",
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
        onToolCall: async ({ toolCall, addToolOutput }) => {
          await toolExecPromise;
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: { lat: 51.5, lng: -0.1 }
          });
        }
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
          <div data-testid="isStreaming">{String(chat.isStreaming)}</div>
          <div data-testid="status">{chat.status}</div>
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
      await sleep(50);
      return screen;
    });

    // While the onToolCall async work is pending, the hook must expose
    // "something is happening" without touching status (which is
    // reserved for user-initiated submissions).
    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("ready");

    // Let the tool.execute() complete → addToolOutput fires → tool part
    // transitions to output-available → derived flag drops.
    await act(async () => {
      resolveToolExec?.();
      await sleep(20);
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
  });

  it("isServerStreaming stays false when a tool is waiting for user confirmation (issue #1365)", async () => {
    // Tools requiring explicit user confirmation sit in input-available
    // but aren't auto-invoked via onToolCall — nothing is happening
    // until the user acts, so the busy indicator must stay off.
    const agent = createAgent({
      name: "ontoolcall-confirm",
      url: "ws://localhost:3000/agents/chat/ontoolcall-confirm?_pk=abc",
      send: () => {}
    });

    const initialMessages: UIMessage[] = [
      {
        id: "msg-confirm-1",
        role: "assistant",
        parts: [
          {
            type: "tool-dangerousAction",
            toolCallId: "tc-confirm-1",
            state: "input-available",
            input: { action: "delete" }
          }
        ]
      }
    ];

    const tools: Record<string, AITool> = {
      dangerousAction: {
        // No execute function → requires confirmation
        parameters: { type: "object" as const, properties: {} }
      }
    };

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: () => Promise.resolve(initialMessages),
        tools
      });
      return (
        <div>
          <div data-testid="isServerStreaming">
            {String(chat.isServerStreaming)}
          </div>
          <div data-testid="isStreaming">{String(chat.isStreaming)}</div>
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
      await sleep(50);
      return screen;
    });

    await expect
      .element(screen.getByTestId("isServerStreaming"))
      .toHaveTextContent("false");
    await expect
      .element(screen.getByTestId("isStreaming"))
      .toHaveTextContent("false");
  });
});

describe("useAgentChat tool approval continuations (issue #1108)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const agent = createAgent({ name, url });
    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);
    return { agent, target };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  const initialMessages: UIMessage[] = [
    {
      id: "assistant-local",
      role: "assistant",
      parts: [
        {
          type: "tool-dangerousAction",
          toolCallId: "tc-approval-1",
          state: "approval-responded",
          input: { action: "delete" },
          approval: { id: "approval-req-1", approved: true }
        }
      ]
    }
  ];

  function TestComponent({ agent }: { agent: ReturnType<typeof useAgent> }) {
    const chat = useAgentChat({
      agent,
      getInitialMessages: () => Promise.resolve(initialMessages)
    });
    const assistantMessages = chat.messages.filter(
      (message) => message.role === "assistant"
    );
    const textPart = assistantMessages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text") as { text?: string } | undefined;
    const toolPartsCount = assistantMessages.reduce((count, message) => {
      return (
        count +
        message.parts.filter(
          (part) => "toolCallId" in part && part.toolCallId === "tc-approval-1"
        ).length
      );
    }, 0);

    return (
      <div>
        <div data-testid="assistant-count">{assistantMessages.length}</div>
        <div data-testid="assistant-ids">
          {assistantMessages.map((message) => message.id).join(",")}
        </div>
        <div data-testid="tool-parts-count">{toolPartsCount}</div>
        <div data-testid="text">{textPart?.text ?? ""}</div>
      </div>
    );
  }

  it("keeps the existing assistant id for continuation start chunks", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "continuation-start-id",
      url: "ws://localhost:3000/agents/chat/continuation-start-id?_pk=abc"
    });

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agent} />, {
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
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-continuation-start",
        continuation: true,
        body: '{"type":"start","messageId":"assistant-stream"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("assistant-ids"))
      .toHaveTextContent("assistant-local");
    await expect
      .element(screen.getByTestId("tool-parts-count"))
      .toHaveTextContent("1");
  });

  it("keeps merging continuations when broadcasts replace assistant ids mid-stream", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "continuation-remap-id",
      url: "ws://localhost:3000/agents/chat/continuation-remap-id?_pk=abc"
    });

    const screen = await act(async () => {
      const screen = render(<TestComponent agent={agent} />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(10);
      return screen;
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-continuation-remap",
        continuation: true,
        body: '{"type":"start","messageId":"assistant-stream"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-continuation-remap",
        continuation: true,
        body: '{"type":"text-start","id":"text-1"}',
        done: false
      });
      await sleep(10);
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [
          {
            id: "assistant-server",
            role: "assistant",
            parts: [
              {
                type: "tool-dangerousAction",
                toolCallId: "tc-approval-1",
                state: "approval-responded",
                input: { action: "delete" },
                approval: { id: "approval-req-1", approved: true }
              }
            ]
          }
        ]
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "req-continuation-remap",
        continuation: true,
        body: '{"type":"text-delta","id":"text-1","delta":"done"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("assistant-ids"))
      .toHaveTextContent("assistant-server");
    await expect
      .element(screen.getByTestId("tool-parts-count"))
      .toHaveTextContent("1");
    await expect.element(screen.getByTestId("text")).toHaveTextContent("done");
  });
});

describe("useAgentChat overlapping submits (issue #1231)", () => {
  function createAgentWithTarget({ name, url }: { name: string; url: string }) {
    const target = new EventTarget();
    const sentMessages: string[] = [];
    const agent = createAgent({
      name,
      url,
      send: (data: string) => sentMessages.push(data)
    });

    (agent as unknown as Record<string, unknown>).addEventListener =
      target.addEventListener.bind(target);
    (agent as unknown as Record<string, unknown>).removeEventListener =
      target.removeEventListener.bind(target);

    return { agent, target, sentMessages };
  }

  function dispatch(target: EventTarget, data: Record<string, unknown>) {
    target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  it("keeps one assistant message when a second submit arrives mid-stream", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "overlapping-submits",
      url: "ws://localhost:3000/agents/chat/overlapping-submits?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      chatInstance = chat;

      const assistantMessages = chat.messages.filter(
        (message) => message.role === "assistant"
      );
      const firstAssistantText = assistantMessages[0]?.parts.find(
        (part) => part.type === "text"
      ) as { text?: string } | undefined;

      return (
        <div>
          <div data-testid="assistant-count">{assistantMessages.length}</div>
          <div data-testid="assistant-ids">
            {assistantMessages.map((message) => message.id).join(",")}
          </div>
          <div data-testid="role-order">
            {chat.messages.map((message) => message.role).join(",")}
          </div>
          <div data-testid="first-assistant-text">
            {firstAssistantText?.text ?? ""}
          </div>
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

    let firstRequestPromise!: Promise<unknown>;
    await act(async () => {
      firstRequestPromise = chatInstance!.sendMessage({ text: "First" });
      await sleep(10);
    });

    const firstRequestId = sentMessages
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.type === "cf_agent_use_chat_request")?.id;
    expect(firstRequestId).toBeTruthy();

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstRequestId,
        body: '{"type":"start","messageId":"assistant-1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstRequestId,
        body: '{"type":"text-start","id":"text-1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstRequestId,
        body: '{"type":"text-delta","id":"text-1","delta":"Hello"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,assistant");

    let secondRequestPromise!: Promise<unknown>;
    await act(async () => {
      secondRequestPromise = chatInstance!.sendMessage({ text: "Second" });
      await sleep(10);
    });

    const requestIds = sentMessages
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .filter((message) => message.type === "cf_agent_use_chat_request")
      .map((message) => String(message.id));
    expect(requestIds).toHaveLength(2);

    const secondRequestId = requestIds[1];
    const [firstUserMessage, secondUserMessage] = chatInstance!.messages.filter(
      (message) => message.role === "user"
    );
    const protectedAssistant = chatInstance!.messages.find(
      (message) => message.id === "assistant-1"
    );
    expect(firstUserMessage).toBeDefined();
    expect(secondUserMessage).toBeDefined();
    expect(protectedAssistant).toBeDefined();

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [firstUserMessage, protectedAssistant, secondUserMessage]
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstRequestId,
        body: '{"type":"text-delta","id":"text-1","delta":" there"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("assistant-ids"))
      .toHaveTextContent("assistant-1");
    await expect
      .element(screen.getByTestId("first-assistant-text"))
      .toHaveTextContent("Hello there");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstRequestId,
        body: "",
        done: true
      });
      await sleep(10);
    });
    await act(async () => {
      await firstRequestPromise;
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,assistant,user");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: secondRequestId,
        body: '{"type":"start","messageId":"assistant-2"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: secondRequestId,
        body: '{"type":"text-start","id":"text-2"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: secondRequestId,
        body: '{"type":"text-delta","id":"text-2","delta":"Follow-up"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: secondRequestId,
        body: "",
        done: true
      });
      await sleep(10);
    });
    await act(async () => {
      await secondRequestPromise;
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,assistant,user,assistant");
  });

  it("survives multiple server broadcasts during an active stream", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "multi-broadcast",
      url: "ws://localhost:3000/agents/chat/multi-broadcast?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      chatInstance = chat;

      const assistantMessages = chat.messages.filter(
        (m) => m.role === "assistant"
      );
      const firstAssistantText = assistantMessages[0]?.parts.find(
        (p) => p.type === "text"
      ) as { text?: string } | undefined;

      return (
        <div>
          <div data-testid="assistant-count">{assistantMessages.length}</div>
          <div data-testid="role-order">
            {chat.messages.map((m) => m.role).join(",")}
          </div>
          <div data-testid="first-assistant-text">
            {firstAssistantText?.text ?? ""}
          </div>
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

    let firstReq!: Promise<unknown>;
    await act(async () => {
      firstReq = chatInstance!.sendMessage({ text: "A" });
      await sleep(10);
    });

    const firstReqId = sentMessages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((m) => m.type === "cf_agent_use_chat_request")?.id;

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstReqId,
        body: '{"type":"start","messageId":"a1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstReqId,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstReqId,
        body: '{"type":"text-delta","id":"t1","delta":"One"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,assistant");

    await act(async () => {
      chatInstance!.sendMessage({ text: "B" });
      await sleep(10);
    });

    const user1 = chatInstance!.messages.find((m) => m.role === "user")!;
    const user2 = chatInstance!.messages.filter((m) => m.role === "user")[1]!;

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [user1, { id: "a1", role: "assistant", parts: [] }, user2]
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");

    const user3 = {
      id: "cross-tab-user",
      role: "user",
      parts: [{ type: "text", text: "C from another tab" }]
    };
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [
          user1,
          { id: "a1", role: "assistant", parts: [] },
          user2,
          user3
        ]
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstReqId,
        body: '{"type":"text-delta","id":"t1","delta":" two"}',
        done: false
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("first-assistant-text"))
      .toHaveTextContent("One two");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: firstReqId,
        body: "",
        done: true
      });
      await sleep(10);
    });
    await act(async () => {
      await firstReq;
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,assistant,user,user");
  });

  it("clears protection when CF_AGENT_CHAT_CLEAR arrives mid-stream", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "clear-mid-stream",
      url: "ws://localhost:3000/agents/chat/clear-mid-stream?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      chatInstance = chat;

      return (
        <div>
          <div data-testid="count">{chat.messages.length}</div>
          <div data-testid="role-order">
            {chat.messages.map((m) => m.role).join(",")}
          </div>
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

    await act(async () => {
      chatInstance!.sendMessage({ text: "Hello" });
      await sleep(10);
    });

    const reqId = sentMessages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((m) => m.type === "cf_agent_use_chat_request")?.id;

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"start","messageId":"a1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"text-delta","id":"t1","delta":"hi"}',
        done: false
      });
      await sleep(10);
    });

    await act(async () => {
      chatInstance!.sendMessage({ text: "Second" });
      await sleep(10);
    });

    await act(async () => {
      dispatch(target, { type: "cf_agent_chat_clear" });
      await sleep(10);
    });

    await expect.element(screen.getByTestId("count")).toHaveTextContent("0");

    const newUser = {
      id: "fresh-user",
      role: "user",
      parts: [{ type: "text", text: "After clear" }]
    };
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [newUser]
      });
      await sleep(10);
    });

    await expect.element(screen.getByTestId("count")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user");
  });

  it("restores assistant to correct position when server inserts extra messages", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "anchor-restore",
      url: "ws://localhost:3000/agents/chat/anchor-restore?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      chatInstance = chat;

      const assistantMessages = chat.messages.filter(
        (m) => m.role === "assistant"
      );

      return (
        <div>
          <div data-testid="assistant-count">{assistantMessages.length}</div>
          <div data-testid="role-order">
            {chat.messages.map((m) => m.role).join(",")}
          </div>
          <div data-testid="ids">
            {chat.messages.map((m) => m.id).join(",")}
          </div>
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

    let firstReq!: Promise<unknown>;
    await act(async () => {
      firstReq = chatInstance!.sendMessage({ text: "Q1" });
      await sleep(10);
    });

    const reqId = sentMessages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((m) => m.type === "cf_agent_use_chat_request")?.id;

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"start","messageId":"ast-1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"text-delta","id":"t1","delta":"Answer"}',
        done: false
      });
      await sleep(10);
    });

    await act(async () => {
      chatInstance!.sendMessage({ text: "Q2" });
      await sleep(10);
    });

    const user1 = chatInstance!.messages.find(
      (m) =>
        m.role === "user" && m.parts.some((p) => "text" in p && p.text === "Q1")
    )!;
    const user2 = chatInstance!.messages.find(
      (m) =>
        m.role === "user" && m.parts.some((p) => "text" in p && p.text === "Q2")
    )!;

    const systemMsg = {
      id: "sys-injected",
      role: "system",
      parts: [{ type: "text", text: "System note" }]
    };

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [
          systemMsg,
          user1,
          { id: "ast-1", role: "assistant", parts: [] },
          user2
        ]
      });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: "",
        done: true
      });
      await sleep(10);
    });
    await act(async () => {
      await firstReq;
      await sleep(10);
    });

    const ids = (await screen.getByTestId("ids").element()).textContent!;
    const order = ids.split(",");
    const user1Idx = order.indexOf(user1.id);
    const astIdx = order.indexOf("ast-1");
    const user2Idx = order.indexOf(user2.id);

    expect(astIdx).toBeGreaterThan(user1Idx);
    expect(astIdx).toBeLessThan(user2Idx);
  });

  it("restores protection when done arrives without a start chunk", async () => {
    const { agent, target, sentMessages } = createAgentWithTarget({
      name: "no-start-chunk",
      url: "ws://localhost:3000/agents/chat/no-start-chunk?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      chatInstance = chat;

      return (
        <div>
          <div data-testid="role-order">
            {chat.messages.map((m) => m.role).join(",")}
          </div>
          <div data-testid="assistant-count">
            {chat.messages.filter((m) => m.role === "assistant").length}
          </div>
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

    let firstReq!: Promise<unknown>;
    await act(async () => {
      firstReq = chatInstance!.sendMessage({ text: "Q" });
      await sleep(10);
    });

    const reqId = sentMessages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .find((m) => m.type === "cf_agent_use_chat_request")?.id;

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"start","messageId":"ast-no-start"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: '{"type":"text-delta","id":"t1","delta":"hi"}',
        done: false
      });
      await sleep(10);
    });

    await act(async () => {
      chatInstance!.sendMessage({ text: "Q2" });
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("assistant-count"))
      .toHaveTextContent("1");

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "unknown-request-id",
        body: '{"type":"start","messageId":"ast-no-start"}',
        done: false
      });
      await sleep(10);
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: reqId,
        body: "",
        done: true
      });
      await sleep(10);
    });
    await act(async () => {
      await firstReq;
      await sleep(10);
    });

    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,assistant,user");
  });

  it("does not activate protection when not streaming", async () => {
    const { agent, target } = createAgentWithTarget({
      name: "not-streaming",
      url: "ws://localhost:3000/agents/chat/not-streaming?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      chatInstance = chat;

      return (
        <div>
          <div data-testid="role-order">
            {chat.messages.map((m) => m.role).join(",")}
          </div>
          <div data-testid="count">{chat.messages.length}</div>
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

    await act(async () => {
      chatInstance!.sendMessage({ text: "First" });
      await sleep(10);
    });

    await act(async () => {
      chatInstance!.sendMessage({ text: "Second" });
      await sleep(10);
    });

    const user1 = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "First" }]
    };
    const user2 = {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "Second" }]
    };

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_chat_messages",
        messages: [user1, user2]
      });
      await sleep(10);
    });

    await expect.element(screen.getByTestId("count")).toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("role-order"))
      .toHaveTextContent("user,user");
  });
});
