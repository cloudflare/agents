// Headless integration test for the client path Think Studio depends on:
// `useAgentChat` driven by a fake agent transport. This validates a streamed
// turn and a tool-approval continuation without a browser, wrangler, or a real
// model — the same deterministic pattern used by @cloudflare/ai-chat's own
// react tests.
import { StrictMode, Suspense, act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeAgent({ name, url }: { name: string; url: string }) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const agent = {
    _pkurl: url,
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data),
    dispatchEvent: target.dispatchEvent.bind(target),
    path: [{ agent: "Chat", name }],
    getHttpUrl: () =>
      url.replace("ws://", "http://").replace("wss://", "https://")
  };
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    target,
    sentMessages
  };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

function findRequestId(sentMessages: string[]) {
  return sentMessages
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .find((message) => message.type === "cf_agent_use_chat_request")?.id as
    | string
    | undefined;
}

describe("Think Studio chat client path", () => {
  it("streams an assistant turn over the agent transport", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "studio-stream",
      url: "ws://localhost:3000/agents/chat/studio-stream?_pk=abc"
    });

    let chatInstance: ReturnType<typeof useAgentChat> | null = null;
    const TestComponent = () => {
      const chat = useAgentChat({ agent, getInitialMessages: null });
      chatInstance = chat;
      const assistant = chat.messages.find((m) => m.role === "assistant");
      const text = assistant?.parts.find((p) => p.type === "text") as
        | { text?: string }
        | undefined;
      return <div data-testid="assistant-text">{text?.text ?? ""}</div>;
    };

    await act(async () => {
      render(
        <StrictMode>
          <Suspense fallback="Loading...">
            <TestComponent />
          </Suspense>
        </StrictMode>
      );
      await sleep(10);
    });

    await act(async () => {
      void chatInstance!.sendMessage({ text: "Hello" });
      await sleep(10);
    });

    const requestId = findRequestId(sentMessages);
    expect(requestId).toBeTruthy();

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: requestId,
        body: '{"type":"start","messageId":"assistant-1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: requestId,
        body: '{"type":"text-start","id":"t1"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: requestId,
        body: '{"type":"text-delta","id":"t1","delta":"Hello from Think"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: requestId,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await waitFor(() => {
      expect(screen.getByTestId("assistant-text").textContent).toBe(
        "Hello from Think"
      );
    });
  });

  it("continues after a tool approval is granted", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "studio-approval",
      url: "ws://localhost:3000/agents/chat/studio-approval?_pk=abc"
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
        getInitialMessages: async (): Promise<UIMessage[]> => initialMessages,
        resume: false
      });
      chatInstance = chat;
      const assistantText = chat.messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("");
      return (
        <div>
          <div data-testid="status">{chat.status}</div>
          <div data-testid="assistant-text">{assistantText}</div>
        </div>
      );
    };

    await act(async () => {
      render(
        <StrictMode>
          <Suspense fallback="Loading...">
            <TestComponent />
          </Suspense>
        </StrictMode>
      );
      await sleep(50);
    });

    await act(async () => {
      chatInstance!.addToolApprovalResponse({
        id: "approval-1",
        approved: true
      });
      await sleep(10);
    });

    // Approving sends an approval message and kicks off a continuation stream.
    const approvalMessage = sentMessages
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.type === "cf_agent_tool_approval");
    expect(approvalMessage?.approved).toBe(true);

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_stream_resuming",
        id: "server-cont-approval"
      });
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
        body: '{"type":"text-delta","id":"t2","delta":"Approved and done"}',
        done: false
      });
      dispatch(target, {
        type: "cf_agent_use_chat_response",
        id: "server-cont-approval",
        continuation: true,
        body: "",
        done: true
      });
      await sleep(10);
    });

    await waitFor(() => {
      expect(screen.getByTestId("assistant-text").textContent).toContain(
        "Approved and done"
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("ready");
    });
  });

  it("keeps setMessages local by default and still clears persisted history", async () => {
    const { agent, sentMessages } = createFakeAgent({
      name: "studio-local-set-messages",
      url: "ws://localhost/agents/chat/studio-local-set-messages?_pk=abc"
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

    render(
      <StrictMode>
        <Suspense fallback="Loading...">
          <TestComponent />
        </Suspense>
      </StrictMode>
    );

    await act(async () => {
      chatInstance!.setMessages([
        {
          id: "local-1",
          role: "user",
          parts: [{ type: "text", text: "Local only" }]
        }
      ]);
      await sleep(10);
    });

    expect(screen.getByTestId("messages-count").textContent).toBe("1");

    const messageSyncFrames = sentMessages
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .filter((message) => message.type === "cf_agent_chat_messages");
    expect(messageSyncFrames).toHaveLength(0);

    await act(async () => {
      chatInstance!.clearHistory();
      await sleep(10);
    });

    const clearFrames = sentMessages
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .filter((message) => message.type === "cf_agent_chat_clear");
    expect(clearFrames).toHaveLength(1);
  });
});
