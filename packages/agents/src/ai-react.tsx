import { useChat } from "@ai-sdk/react";
import type { Message } from "ai";
import type { useAgent } from "./react";
import { useEffect, use } from "react";
import type { OutgoingMessage } from "./ai-types";

/**
 * Options for the useAgentChat hook
 */
type UseAgentChatOptions = Omit<
  Parameters<typeof useChat>[0] & {
    /** Agent connection from useAgent */
    agent: ReturnType<typeof useAgent>;
  },
  "fetch"
>;

// TODO: clear cache when the agent is unmounted?
const requestCache = new Map<string, Promise<unknown>>();

/**
 * React hook for building AI chat interfaces using an Agent
 * @param options Chat options including the agent connection
 * @returns Chat interface controls and state with added clearHistory method
 */
export function useAgentChat(options: UseAgentChatOptions) {
  const { agent, ...rest } = options;
  const url = `${agent._pkurl
    .replace("ws://", "http://")
    .replace("wss://", "https://")}/get-messages`;

  const initialMessages = use(
    (() => {
      if (requestCache.has(url)) {
        return requestCache.get(url)!;
      }
      const promise = fetch(new Request(url), {
        headers: options.headers,
      }).then((res) => res.json());
      requestCache.set(url, promise);
      return promise;
    })()
  ) as Message[];

  async function aiFetch(
    request: RequestInfo | URL,
    options: RequestInit = {}
  ) {
    // we're going to use a websocket to do the actual "fetching"
    // but still satisfy the type signature of the fetch function
    // so we'll return a promise that resolves to a response

    const {
      method,
      keepalive,
      headers,
      body,
      redirect,
      integrity,
      signal,
      credentials,
      mode,
      referrer,
      referrerPolicy,
      window,
      //  dispatcher, duplex
    } = options;
    const id = crypto.randomUUID();
    const abortController = new AbortController();

    signal?.addEventListener("abort", () => {
      abortController.abort();
    });

    agent.addEventListener(
      "message",
      (event) => {
        const data = JSON.parse(event.data) as OutgoingMessage;
        if (data.type === "cf_agent_use_chat_response") {
          if (data.id === id) {
            controller.enqueue(new TextEncoder().encode(data.body));
            if (data.done) {
              controller.close();
              abortController.abort();
            }
          }
        }
      },
      { signal: abortController.signal }
    );

    let controller: ReadableStreamDefaultController;

    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
    });

    agent.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id,
        url: request.toString(),
        init: {
          method,
          keepalive,
          headers,
          body,
          redirect,
          integrity,
          credentials,
          mode,
          referrer,
          referrerPolicy,
          window,
          // dispatcher,
          // duplex
        },
      })
    );

    return new Response(stream);
  }
  const useChatHelpers = useChat({
    initialMessages,
    sendExtraMessageFields: true,
    fetch: aiFetch,
    ...rest,
  });

  useEffect(() => {
    agent.send(
      JSON.stringify({
        type: "cf_agent_chat_init",
      })
    );

    function onClearHistory(event: MessageEvent) {
      if (typeof event.data !== "string") {
        return;
      }
      const data = JSON.parse(event.data) as OutgoingMessage;
      if (data.type === "cf_agent_chat_clear") {
        useChatHelpers.setMessages([]);
      }
    }

    function onMessages(event: MessageEvent) {
      if (typeof event.data !== "string") {
        return;
      }
      const data = JSON.parse(event.data) as OutgoingMessage;
      if (data.type === "cf_agent_chat_messages") {
        useChatHelpers.setMessages(data.messages);
      }
    }

    agent.addEventListener("message", onClearHistory);
    agent.addEventListener("message", onMessages);

    return () => {
      agent.removeEventListener("message", onClearHistory);
      agent.removeEventListener("message", onMessages);
    };
  }, [
    agent.addEventListener,
    agent.removeEventListener,
    agent.send,
    useChatHelpers.setMessages,
  ]);

  return {
    ...useChatHelpers,
    /**
     * Set the chat messages and synchronize with the Agent
     * @param messages New messages to set
     */
    setMessages: (messages: Message[]) => {
      useChatHelpers.setMessages(messages);
      agent.send(
        JSON.stringify({
          type: "cf_agent_chat_messages",
          messages,
        })
      );
    },
    /**
     * Clear chat history on both client and Agent
     */
    clearHistory: () => {
      useChatHelpers.setMessages([]);
      agent.send(
        JSON.stringify({
          type: "cf_agent_chat_clear",
        })
      );
    },
  };
}
