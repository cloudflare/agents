import { useChat } from "@ai-sdk/react";
import type { UIMessage as Message } from "ai";
import { DefaultChatTransport } from "ai";
import { nanoid } from "nanoid";
import { use, useEffect } from "react";
import type { OutgoingMessage } from "./ai-types";
import { MessageType } from "./ai-types";
import type { useAgent } from "./react";

type GetInitialMessagesOptions = {
  agent: string;
  name: string;
  url: string;
};

/**
 * Options for the useAgentChat hook
 */
type UseAgentChatOptions<State> = Omit<
  Parameters<typeof useChat>[0],
  "fetch" | "messages"
> & {
  /** Agent connection from useAgent */
  agent: ReturnType<typeof useAgent<State>>;
  getInitialMessages?:
    | undefined
    | null
    // | (() => Message[])
    | ((options: GetInitialMessagesOptions) => Promise<Message[]>);
  messages?: Message[];
  /** Request credentials */
  credentials?: RequestCredentials;
  /** Request headers */
  headers?: HeadersInit;
};

const requestCache = new Map<string, Promise<Message[]>>();

/**
 * React hook for building AI chat interfaces using an Agent
 * @param options Chat options including the agent connection
 * @returns Chat interface controls and state with added clearHistory method
 */
export function useAgentChat<State = unknown>(
  options: UseAgentChatOptions<State>
): ReturnType<typeof useChat> & {
  clearHistory: () => void;
} {
  const {
    agent,
    getInitialMessages,
    messages: optionsInitialMessages,
    ...rest
  } = options;

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
    url
  }: GetInitialMessagesOptions) {
    const getMessagesUrl = new URL(url);
    getMessagesUrl.pathname += "/get-messages";
    const response = await fetch(getMessagesUrl.toString(), {
      credentials: options.credentials,
      headers: options.headers
    });
    return response.json<Message[]>();
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
    // immediately cache the promise so that we don't
    // create multiple requests for the same agent during multiple
    // concurrent renders
    requestCache.set(agentUrlString, promise);
    return promise;
  }

  const initialMessagesPromise =
    getInitialMessages === null
      ? null
      : doGetInitialMessages({
          agent: agent.agent,
          name: agent.name,
          url: agentUrlString
        });
  const initialMessages = initialMessagesPromise
    ? use(initialMessagesPromise)
    : (optionsInitialMessages ?? []);

  // manages adding and removing the promise from the cache
  useEffect(() => {
    if (!initialMessagesPromise) {
      return;
    }
    // this effect is responsible for removing the promise from the cache
    // when the component unmounts or the promise changes,
    // but that means it also must add the promise to the cache
    // so that multiple arbitrary effect runs produce the expected state
    // when resolved.
    requestCache.set(agentUrlString, initialMessagesPromise!);
    return () => {
      if (requestCache.get(agentUrlString) === initialMessagesPromise) {
        requestCache.delete(agentUrlString);
      }
    };
  }, [agentUrlString, initialMessagesPromise]);

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
      window
      //  dispatcher, duplex
    } = options;
    const id = nanoid(8);
    const abortController = new AbortController();

    signal?.addEventListener("abort", () => {
      // Propagate request cancellation to the Agent
      // We need to communciate cancellation as a websocket message, instead of a request signal
      agent.send(
        JSON.stringify({
          id,
          type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
        })
      );

      // NOTE - If we wanted to, we could preserve the "interrupted" message here, with the code below
      //        However, I think it might be the responsibility of the library user to implement that behavior manually?
      //        Reasoning: This code could be subject to collisions, as it "force saves" the messages we have locally
      //
      // agent.send(JSON.stringify({
      //   type: MessageType.CF_AGENT_CHAT_MESSAGES,
      //   messages: ... /* some way of getting current messages ref? */
      // }))

      abortController.abort();
      // Make sure to also close the stream (cf. https://github.com/cloudflare/agents-starter/issues/69)
      controller.close();
    });

    agent.addEventListener(
      "message",
      (event) => {
        let data: OutgoingMessage;
        try {
          data = JSON.parse(event.data) as OutgoingMessage;
        } catch (_error) {
          // silently ignore invalid messages for now
          // TODO: log errors with log levels
          return;
        }
        if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE) {
          if (data.id === id) {
            if (data.error) {
              // Handle error response - enqueue the error message before closing
              controller.enqueue(new TextEncoder().encode(data.body));
              controller.close();
              abortController.abort();
            } else {
              controller.enqueue(new TextEncoder().encode(data.body));
              if (data.done) {
                controller.close();
                abortController.abort();
              }
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
      }
    });

    agent.send(
      JSON.stringify({
        id,
        init: {
          body,
          credentials,
          headers,
          integrity,
          keepalive,
          method,
          mode,
          redirect,
          referrer,
          referrerPolicy,
          window
          // dispatcher,
          // duplex
        },
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        url: request.toString()
      })
    );

    return new Response(stream);
  }
  const customTransport = {
    sendMessages: async ({
      trigger,
      chatId,
      messageId,
      messages,
      abortSignal,
      ...options
    }: {
      trigger: "submit-message" | "regenerate-message";
      chatId: string;
      messageId: string | undefined;
      messages: Message[];
      abortSignal: AbortSignal | undefined;
    } & Parameters<typeof useChat>[0]) => {
      const transport = new DefaultChatTransport({
        api: agentUrlString,
        fetch: aiFetch
      });

      return transport.sendMessages({
        trigger,
        chatId,
        messageId,
        messages,
        abortSignal,
        ...options
      });
    },
    reconnectToStream: async ({
      chatId,
      ...options
    }: {
      chatId: string;
    } & Parameters<typeof useChat>[0]) => {
      const transport = new DefaultChatTransport({
        api: agentUrlString,
        fetch: aiFetch
      });

      return transport.reconnectToStream({
        chatId,
        ...options
      });
    }
  };

  const useChatHelpers = useChat({
    messages: initialMessages,
    transport: customTransport,
    ...rest
  });

  useEffect(() => {
    function onClearHistory(event: MessageEvent) {
      if (typeof event.data !== "string") {
        return;
      }
      let data: OutgoingMessage;
      try {
        data = JSON.parse(event.data) as OutgoingMessage;
      } catch (_error) {
        // silently ignore invalid messages for now
        // TODO: log errors with log levels
        return;
      }
      if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
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
      } catch (_error) {
        // silently ignore invalid messages for now
        // TODO: log errors with log levels
        return;
      }
      if (data.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
        useChatHelpers.setMessages(data.messages);
      }
    }

    agent.addEventListener("message", onClearHistory);
    agent.addEventListener("message", onMessages);

    return () => {
      agent.removeEventListener("message", onClearHistory);
      agent.removeEventListener("message", onMessages);
    };
  }, [agent, useChatHelpers.setMessages]);

  return {
    ...useChatHelpers,
    /**
     * Clear chat history on both client and Agent
     */
    clearHistory: () => {
      useChatHelpers.setMessages([]);
      agent.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_CHAT_CLEAR
        })
      );
    },
    /**
     * Set the chat messages and synchronize with the Agent
     * @param messages New messages to set
     */
    setMessages: (
      messages: Parameters<typeof useChatHelpers.setMessages>[0]
    ) => {
      useChatHelpers.setMessages(messages);
      agent.send(
        JSON.stringify({
          messages: Array.isArray(messages) ? messages : [],
          type: MessageType.CF_AGENT_CHAT_MESSAGES
        })
      );
    }
  };
}
