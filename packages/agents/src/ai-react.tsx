import { useChat } from "@ai-sdk/react";
import type { Message } from "ai";
import type { useAgent } from "./react";
import { useEffect, use, useState } from "react";
import type { OutgoingMessage } from "./ai-types";

type GetInitialMessagesOptions = {
  agent: string;
  name: string;
  url: string;
};

/**
 * Options for the useAgentChat hook
 */
type UseAgentChatOptions<State> = Omit<
  Parameters<typeof useChat>[0] & {
    /** Agent connection from useAgent */
    agent: ReturnType<typeof useAgent<State>>;
    getInitialMessages?:
      | undefined
      | null
      // | (() => Message[])
      | ((options: GetInitialMessagesOptions) => Promise<Message[]>);
  },
  "fetch"
>;

// TODO: clear cache when the agent is unmounted?
const requestCache = new Map<string, Promise<Message[]>>();

/**
 * React hook for building AI chat interfaces using an Agent
 * @param options Chat options including the agent connection
 * @returns Chat interface controls and state with added clearHistory method
 */
export function useAgentChat<State = unknown>(
  options: UseAgentChatOptions<State>
) {
  const { agent, getInitialMessages, onError, ...rest } = options;
  const [error, setError] = useState<Error|undefined>()

  const agentUrl = new URL(
    `${// @ts-expect-error we're using a protected _url property that includes query params
    ((agent._url as string | null) || agent._pkurl)
      ?.replace("ws://", "http://")
      .replace("wss://", "https://")}`
  );

  // delete the _pk query param
  agentUrl.searchParams.delete("_pk");
  const agentUrlString = agentUrl.toString();

  async function defaultGetInitialMessagesFetch({
    url,
  }: GetInitialMessagesOptions) {
    const getMessagesUrl = new URL(url);
    getMessagesUrl.pathname += "/get-messages";
    try {
      const response = await fetch(getMessagesUrl.toString(), {
        headers: options.headers,
        credentials: options.credentials,
      });
      return response.json<Message[]>();
    } catch (e) {
      const errorInstance = new Error(`Error getting messages: ${e}`);
      onError?.(errorInstance);
      setError(errorInstance);
      return [];
    }
  }

  const getInitialMessagesFetch =
    getInitialMessages || defaultGetInitialMessagesFetch;

  function doGetInitialMessages(
    getInitialMessagesOptions: GetInitialMessagesOptions
  ) {
    if (requestCache.has(agentUrlString)) {
      return requestCache.get(agentUrlString)!;
    }
    const promise = getInitialMessagesFetch(getInitialMessagesOptions);
    requestCache.set(agentUrlString, promise);
    return promise;
  }

  const initialMessages =
    getInitialMessages !== null
      ? use(
          doGetInitialMessages({
            agent: agent.agent,
            name: agent.name,
            url: agentUrlString,
          })
        )
      : rest.initialMessages;

  useEffect(() => {
    return () => {
      requestCache.delete(agentUrlString);
    };
  }, [agentUrlString]);

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
        let data: OutgoingMessage;
        try {
          data = JSON.parse(event.data) as OutgoingMessage;
        } catch (e) {
          const errorInstance = new Error(`Error parsing onClearHistory messages: ${e}`);
          onError?.(errorInstance)
          setError(errorInstance);
          return;
        }
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
    function onClearHistory(event: MessageEvent) {
      if (typeof event.data !== "string") {
        return;
      }
      let data: OutgoingMessage;
      try {
        data = JSON.parse(event.data) as OutgoingMessage;
      } catch (e) {
        const errorInstance = new Error(`Error parsing onClearHistory messages: ${e}`);
        onError?.(errorInstance)
        setError(errorInstance);
        return;
      }
      if (data.type === "cf_agent_chat_clear") {
        useChatHelpers.setMessages([]);
      }
    }

    function onMessages(event: MessageEvent) {
      if (typeof event.data !== "string") {
        return;
      }
      let data: OutgoingMessage;
      try {
        data = JSON.parse(event.data) as OutgoingMessage;
      } catch (e) {
        const errorInstance = new Error(`Error parsing onMessages messages: ${e}`);
        onError?.(errorInstance)
        setError(errorInstance);
        return;
      }
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
    useChatHelpers.setMessages,
    onError,
  ]);

  return {
    ...useChatHelpers,
    error: useChatHelpers.error ?? error,
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
