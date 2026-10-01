import type { UIMessageChunk } from "ai";
import { WebSocketChatTransport } from "agents/chat/transport";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { capnWebTransportUrl } from "../../../websockets/transport-protocol";
import type {
  ChannelChunk,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelStreamOptions,
  DeliveryResult
} from "../../channel";
import type { ChannelMessageSurface } from "../../surface";
import {
  requiredEnv,
  type LiveDeliveryBinding,
  type LiveDeliveryHost,
  type ObservedMessage
} from "../binding";

type WebObservation = {
  text: string;
  reasoning: string[];
  sources: Array<{ url: string; title?: string }>;
  error?: string;
};

type StreamHandle = { id: string };

type ClientToolRoundTripObservation = {
  tool: { name: string; input: unknown };
  member: {
    priorHistory: string[];
    userMessage: string;
    text: string;
    reasoning: string[];
    toolCalls: number;
  };
  continuation: { text: string; reasoning: string[] };
};

type WebLiveDeliveryBinding = LiveDeliveryBinding & {
  sharedConversationRoundTrip(): Promise<ClientToolRoundTripObservation>;
  durableReplayRoundTrip(): Promise<{ text: string; textDeltas: number }>;
  durableErroredReplayRoundTrip(): Promise<{ text: string; error: string }>;
  durableClientToolReplayRoundTrip(): Promise<{
    replayedToolCalls: number;
    routedToolResults: number;
    memberToolCalls: number;
  }>;
};

type WebLiveControl = {
  surface(): Promise<ChannelMessageSurface | null>;
  toolResultCount(): Promise<number>;
  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult>;
  startStream(
    surface: ChannelMessageSurface,
    options?: ChannelStreamOptions
  ): Promise<StreamHandle>;
  push(id: string, chunk: ChannelChunk): Promise<void>;
  finish(id: string): Promise<DeliveryResult>;
  fail(id: string, reason: string): Promise<DeliveryResult>;
  clear(): Promise<void>;
};

function webSocketUrl(url: URL): string {
  const socket = new URL(url);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  return socket.toString();
}

function callablesUrl(url: URL): string {
  return capnWebTransportUrl(url);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function within<T>(label: string, promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out ${label}`)), 10_000);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out opening the Web live-test socket")),
      30_000
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("Failed to open the Web live-test socket"));
      },
      { once: true }
    );
  });
}

/** Apply the AI SDK chunks observed by the real browser transport. */
function observeChunk(
  observation: WebObservation,
  chunk: UIMessageChunk
): void {
  switch (chunk.type) {
    case "text-delta":
      observation.text += chunk.delta;
      return;
    case "reasoning-delta": {
      const index = observation.reasoning.length - 1;
      if (index < 0) observation.reasoning.push(chunk.delta);
      else observation.reasoning[index] += chunk.delta;
      return;
    }
    case "reasoning-start":
      observation.reasoning.push("");
      return;
    case "source-url":
      observation.sources.push({
        url: chunk.url,
        ...(chunk.title !== undefined && { title: chunk.title })
      });
      return;
    default:
      return;
  }
}

async function observeStream(
  stream: ReadableStream<UIMessageChunk>
): Promise<WebObservation> {
  const observation: WebObservation = { text: "", reasoning: [], sources: [] };
  for await (const chunk of stream) observeChunk(observation, chunk);
  return observation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observeConversation(
  socket: WebSocket,
  expectedResponses: number
): {
  complete: Promise<{
    priorHistory: string[];
    userMessage: string;
    text: string;
    reasoning: string[];
    toolCalls: number;
  }>;
  dispose(): void;
} {
  const observation: WebObservation & {
    priorHistory: string[];
    userMessage: string;
    toolCalls: number;
  } = {
    priorHistory: [],
    userMessage: "",
    text: "",
    reasoning: [],
    sources: [],
    toolCalls: 0
  };
  let completedResponses = 0;
  let settle!: () => void;
  const observed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const timeout = setTimeout(settle, 30_000);

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;

    if (
      frame.type === "cf_agent_chat_messages" &&
      Array.isArray(frame.messages)
    ) {
      const texts = frame.messages.map((message) => {
        if (!isRecord(message) || !Array.isArray(message.parts)) return "";
        return message.parts
          .filter(
            (part): part is { type: "text"; text: string } =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string"
          )
          .map((part) => part.text)
          .join("");
      });
      observation.priorHistory = texts.slice(0, 2);
      const userMessages = frame.messages.filter(
        (message) => isRecord(message) && message.role === "user"
      );
      const latestUser = userMessages.at(-1);
      if (isRecord(latestUser) && Array.isArray(latestUser.parts)) {
        observation.userMessage = latestUser.parts
          .filter(
            (part): part is { type: "text"; text: string } =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string"
          )
          .map((part) => part.text)
          .join("");
      }
      return;
    }

    if (frame.type !== "cf_agent_use_chat_response") return;
    if (typeof frame.body === "string" && frame.body.trim()) {
      try {
        const chunk = JSON.parse(frame.body) as UIMessageChunk;
        if (chunk.type === "tool-input-available") {
          observation.toolCalls += 1;
        }
        observeChunk(observation, chunk);
      } catch {
        // Error response bodies are plain text rather than UI message chunks.
      }
    }
    if (frame.done === true) {
      completedResponses += 1;
      if (completedResponses >= expectedResponses) settle();
    }
  };
  socket.addEventListener("message", onMessage);

  return {
    complete: observed.then(() => {
      if (completedResponses < expectedResponses) {
        throw new Error(
          `Timed out observing ${expectedResponses} shared Web responses`
        );
      }
      return {
        priorHistory: observation.priorHistory,
        userMessage: observation.userMessage,
        text: observation.text,
        reasoning: observation.reasoning,
        toolCalls: observation.toolCalls
      };
    }),
    dispose() {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
    }
  };
}

/**
 * A live Web destination backed by a deployed bare Durable Object fixture.
 * The chat socket is the independent observer; a non-hibernating Cap'n Web
 * session makes the fixture's real ChannelHost perform each operation.
 */
export function webBinding(): WebLiveDeliveryBinding {
  const fixtureUrl = new URL(requiredEnv("CHANNELS_LIVE_WEB_URL"));
  const token = process.env.CHANNELS_LIVE_WEB_TOKEN;
  const objectName = `channels-live-${crypto.randomUUID()}`;
  let surface: ChannelMessageSurface | undefined;
  let socket: WebSocket | undefined;
  let control: RpcStub<WebLiveControl> | undefined;
  let observation: WebObservation | undefined;
  let observing: Promise<void> | undefined;

  function url(path: string): URL {
    const result = new URL(fixtureUrl);
    result.pathname = `${result.pathname.replace(/\/$/, "")}${path}`;
    result.searchParams.set("name", objectName);
    if (token) result.searchParams.set("token", token);
    return result;
  }

  function rpc(): RpcStub<WebLiveControl> {
    if (!control) throw new Error("Web live-test control plane is not open");
    return control;
  }

  const host: LiveDeliveryHost = {
    deliver(
      destination: ChannelMessageSurface,
      message: ChannelMessage,
      options?: ChannelDeliveryOptions
    ) {
      return rpc().deliver(destination, message, options);
    },

    async stream(
      destination: ChannelMessageSurface,
      chunks: ReadableStream<ChannelChunk>,
      options?: ChannelStreamOptions
    ): Promise<DeliveryResult> {
      const handle = await rpc().startStream(destination, options);
      const reader = chunks.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          await rpc().push(handle.id, next.value);
        }
      } catch (error) {
        return rpc().fail(handle.id, errorText(error));
      } finally {
        reader.releaseLock();
      }
      return rpc().finish(handle.id);
    }
  };

  return {
    name: "web",
    destination: fixtureUrl.toString(),
    host,
    get surface() {
      if (!surface) throw new Error("Web live-test destination is not open");
      return surface;
    },
    async open() {
      const chatUrl = url("/chat");
      chatUrl.searchParams.set("conversationId", objectName);
      chatUrl.searchParams.set("participantId", "conversation-member");
      control = newWebSocketRpcSession<WebLiveControl>(callablesUrl(chatUrl));
      socket = new WebSocket(webSocketUrl(chatUrl));
      await waitForOpen(socket);
      const transport = new WebSocketChatTransport({ agent: socket });
      const chunks = await transport.sendMessages({
        chatId: objectName,
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "Open live-test destination" }]
          }
        ],
        abortSignal: undefined,
        trigger: "submit-message"
      });

      observation = { text: "", reasoning: [], sources: [] };
      observing = (async () => {
        try {
          for await (const chunk of chunks) {
            observeChunk(observation!, chunk);
          }
        } catch (error) {
          observation!.error = errorText(error);
        }
      })();

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const captured = await rpc().surface();
        if (captured) {
          surface = captured;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Web live-test fixture did not capture a reply surface");
    },
    async clear() {
      await rpc().clear();
      observation = undefined;
      surface = undefined;
    },
    async read(): Promise<ObservedMessage[]> {
      if (!observation) return [];
      const message: ObservedMessage = { text: observation.text };
      if (observation.reasoning.some(Boolean)) {
        message.reasoning = observation.reasoning.filter(Boolean);
      }
      if (observation.sources.length > 0) {
        message.sources = observation.sources;
      }
      if (observation.error !== undefined) message.error = observation.error;
      return message.text || Object.keys(message).length > 1 ? [message] : [];
    },
    async durableReplayRoundTrip(): Promise<{
      text: string;
      textDeltas: number;
    }> {
      if (!socket || !surface) {
        throw new Error("Web live-test destination is not open");
      }
      socket.close();
      await delay(100);

      const responseId = `durable-response:${crypto.randomUUID()}`;
      const address = surface.address as { requestId?: unknown } | null;
      if (typeof address?.requestId !== "string") {
        throw new Error("Web live-test surface has no request ID");
      }
      const requestId = address.requestId;
      const handle = await within(
        "starting the durable response",
        rpc().startStream(surface, {
          response: {
            id: responseId,
            conversationId: objectName,
            messageId: `assistant:${responseId}`
          }
        })
      );
      await within(
        "writing the durable prefix",
        rpc().push(handle.id, { type: "text", text: "Durable prefix " })
      );

      const replacementUrl = url("/chat");
      replacementUrl.searchParams.set("conversationId", objectName);
      replacementUrl.searchParams.set("participantId", "conversation-member");
      const replacement = new WebSocket(webSocketUrl(replacementUrl));
      await within(
        "opening the replacement Web socket",
        waitForOpen(replacement)
      );
      socket = replacement;

      let text = "";
      let textDeltas = 0;
      let prefixObserved!: () => void;
      const prefix = new Promise<void>((resolve) => {
        prefixObserved = resolve;
      });
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      replacement.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (
          frame.type === "cf_agent_stream_resuming" &&
          frame.id === requestId
        ) {
          replacement.send(
            JSON.stringify({
              type: "cf_agent_stream_resume_ack",
              id: requestId
            })
          );
          return;
        }
        if (frame.type !== "cf_agent_use_chat_response") return;
        if (typeof frame.body === "string" && frame.body) {
          const chunk = JSON.parse(frame.body) as UIMessageChunk;
          if (chunk.type === "text-delta") {
            text += chunk.delta;
            textDeltas += 1;
            if (text.includes("Durable prefix")) prefixObserved();
          }
        }
        if (frame.done === true) complete();
      });
      replacement.send(
        JSON.stringify({
          type: "cf_agent_stream_resume_request",
          probeId: "durable-live-test"
        })
      );

      await within("replaying the durable Web prefix", prefix);
      await within(
        "writing the durable live tail",
        rpc().push(handle.id, { type: "text", text: "and live tail" })
      );
      await rpc().finish(handle.id);
      await within("following the durable Web live tail", completed);
      return { text, textDeltas };
    },
    async durableErroredReplayRoundTrip(): Promise<{
      text: string;
      error: string;
    }> {
      if (!socket || !surface) {
        throw new Error("Web live-test destination is not open");
      }
      socket.close();
      await delay(100);

      const responseId = `durable-error:${crypto.randomUUID()}`;
      const address = surface.address as { requestId?: unknown } | null;
      if (typeof address?.requestId !== "string") {
        throw new Error("Web live-test surface has no request ID");
      }
      const requestId = address.requestId;
      const handle = await rpc().startStream(surface, {
        response: {
          id: responseId,
          conversationId: objectName,
          messageId: `assistant:${responseId}`
        }
      });
      await rpc().push(handle.id, {
        type: "text",
        text: "Durable partial answer"
      });
      await rpc().fail(handle.id, "durable generation failed");

      const replacementUrl = url("/chat");
      replacementUrl.searchParams.set("conversationId", objectName);
      replacementUrl.searchParams.set("participantId", "conversation-member");
      const replacement = new WebSocket(webSocketUrl(replacementUrl));
      await within(
        "opening the errored-response replacement socket",
        waitForOpen(replacement)
      );
      socket = replacement;

      let text = "";
      let streamError = "";
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      replacement.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (
          frame.type === "cf_agent_stream_resuming" &&
          frame.id === requestId
        ) {
          replacement.send(
            JSON.stringify({
              type: "cf_agent_stream_resume_ack",
              id: requestId
            })
          );
          return;
        }
        if (frame.type !== "cf_agent_use_chat_response") return;
        if (frame.done === true && frame.error === true) {
          streamError = typeof frame.body === "string" ? frame.body : "";
          complete();
          return;
        }
        if (typeof frame.body !== "string" || !frame.body) return;
        const chunk = JSON.parse(frame.body) as UIMessageChunk;
        if (chunk.type === "text-delta") text += chunk.delta;
      });
      replacement.send(
        JSON.stringify({
          type: "cf_agent_stream_resume_request",
          probeId: "durable-error-live-test"
        })
      );
      await within("replaying the errored durable response", completed);
      return { text, error: streamError };
    },
    async durableClientToolReplayRoundTrip(): Promise<{
      replayedToolCalls: number;
      routedToolResults: number;
      memberToolCalls: number;
    }> {
      if (!socket) throw new Error("Web conversation member is not open");
      let memberToolCalls = 0;
      const countMemberTools = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (
          frame.type !== "cf_agent_use_chat_response" ||
          typeof frame.body !== "string" ||
          !frame.body
        ) {
          return;
        }
        const chunk = JSON.parse(frame.body) as UIMessageChunk;
        if (chunk.type === "tool-input-available") memberToolCalls += 1;
      };
      socket.addEventListener("message", countMemberTools);

      const requestId = `durable-tool-request:${crypto.randomUUID()}`;
      const messageId = `durable-tool-message:${crypto.randomUUID()}`;
      const toolCallId = `describe-browser:${messageId}`;
      const ownerUrl = url("/chat");
      ownerUrl.searchParams.set("conversationId", objectName);
      ownerUrl.searchParams.set("participantId", "durable-tool-owner");
      const owner = new WebSocket(webSocketUrl(ownerUrl));
      await within("opening the original tool owner", waitForOpen(owner));
      let initialToolObserved!: () => void;
      const initialTool = new Promise<void>((resolve) => {
        initialToolObserved = resolve;
      });
      owner.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (
          frame.type !== "cf_agent_use_chat_response" ||
          typeof frame.body !== "string" ||
          !frame.body
        ) {
          return;
        }
        const chunk = JSON.parse(frame.body) as UIMessageChunk;
        if (
          chunk.type === "tool-input-available" &&
          chunk.toolCallId === toolCallId
        ) {
          initialToolObserved();
        }
      });
      owner.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: {
            method: "POST",
            body: JSON.stringify({
              demo: "client-tool",
              clientTools: [
                {
                  name: "describeBrowser",
                  parameters: { type: "object" }
                }
              ],
              messages: [
                {
                  id: messageId,
                  role: "user",
                  parts: [{ type: "text", text: "Replay this browser tool" }]
                }
              ]
            })
          }
        })
      );
      await within("receiving the original browser tool", initialTool);
      owner.close();
      await delay(100);

      const replacement = new WebSocket(webSocketUrl(ownerUrl));
      await within(
        "opening the replacement tool owner",
        waitForOpen(replacement)
      );
      let replayedToolCalls = 0;
      let replayedToolObserved!: () => void;
      const replayedTool = new Promise<void>((resolve) => {
        replayedToolObserved = resolve;
      });
      replacement.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const frame = JSON.parse(event.data) as Record<string, unknown>;
        if (
          frame.type === "cf_agent_stream_resuming" &&
          frame.id === requestId
        ) {
          replacement.send(
            JSON.stringify({
              type: "cf_agent_stream_resume_ack",
              id: requestId
            })
          );
          return;
        }
        if (
          frame.type !== "cf_agent_use_chat_response" ||
          typeof frame.body !== "string" ||
          !frame.body
        ) {
          return;
        }
        const chunk = JSON.parse(frame.body) as UIMessageChunk;
        if (
          chunk.type === "tool-input-available" &&
          chunk.toolCallId === toolCallId
        ) {
          replayedToolCalls += 1;
          replacement.send(
            JSON.stringify({
              type: "cf_agent_tool_result",
              toolCallId,
              toolName: "describeBrowser",
              state: "output-available",
              output: { timezone: "Etc/UTC" },
              autoContinue: false
            })
          );
          replayedToolObserved();
        }
      });
      replacement.send(
        JSON.stringify({
          type: "cf_agent_stream_resume_request",
          probeId: "durable-tool-replay"
        })
      );
      await within("replaying the browser tool", replayedTool);

      const routedToolResults = await within(
        "routing the replayed browser tool result",
        (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const count = await rpc().toolResultCount();
            if (count > 0) return count;
            await delay(50);
          }
          throw new Error("The replayed browser tool result was not routed");
        })()
      );
      replacement.close();
      socket.removeEventListener("message", countMemberTools);
      return { replayedToolCalls, routedToolResults, memberToolCalls };
    },
    async sharedConversationRoundTrip(): Promise<ClientToolRoundTripObservation> {
      if (!socket) throw new Error("Web conversation member is not open");
      const ownerUrl = url("/chat");
      ownerUrl.searchParams.set("conversationId", objectName);
      ownerUrl.searchParams.set("participantId", "turn-owner");
      const toolSocket = new WebSocket(webSocketUrl(ownerUrl));
      await waitForOpen(toolSocket);
      const memberObserver = observeConversation(socket, 2);
      void memberObserver.complete.catch(() => {});
      const transport = new WebSocketChatTransport({ agent: toolSocket });
      toolSocket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object" || !("type" in message)) {
          return;
        }
        if (
          message.type === "cf_agent_stream_resuming" &&
          "id" in message &&
          typeof message.id === "string"
        ) {
          transport.handleStreamResuming({ id: message.id });
        } else if (message.type === "cf_agent_stream_resume_none") {
          transport.handleStreamResumeNone(
            "probeId" in message && typeof message.probeId === "string"
              ? { probeId: message.probeId }
              : {}
          );
        } else if (message.type === "cf_agent_stream_pending") {
          transport.handleStreamPending();
        }
      });
      const clientTools = [
        {
          name: "describeBrowser",
          description: "Describe the live-test browser",
          parameters: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
            additionalProperties: false
          }
        }
      ];

      try {
        const initial = await transport.sendMessages({
          chatId: objectName,
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [
                { type: "text", text: "Run the Web client-tool live test" }
              ]
            }
          ],
          abortSignal: undefined,
          trigger: "submit-message",
          body: { demo: "client-tool", clientTools }
        });
        let tool: { id: string; name: string; input: unknown } | undefined;
        for await (const chunk of initial) {
          if (chunk.type === "tool-input-available") {
            tool = {
              id: chunk.toolCallId,
              name: chunk.toolName,
              input: chunk.input
            };
          }
        }
        if (!tool) throw new Error("Web Channel did not request a client tool");

        toolSocket.send(
          JSON.stringify({
            type: "cf_agent_tool_result",
            toolCallId: tool.id,
            toolName: tool.name,
            output: { language: "en-US", timezone: "Etc/UTC" },
            state: "output-available",
            autoContinue: true,
            clientTools
          })
        );
        transport.expectToolContinuation();
        const continued = await transport.reconnectToStream({
          chatId: objectName
        });
        if (!continued) {
          throw new Error("Web Channel did not offer a tool continuation");
        }
        const continuation = await observeStream(continued);
        const member = await memberObserver.complete;
        return {
          tool: { name: tool.name, input: tool.input },
          member,
          continuation: {
            text: continuation.text,
            reasoning: continuation.reasoning
          }
        };
      } finally {
        memberObserver.dispose();
        toolSocket.close(1000, "client-tool live test complete");
      }
    },
    async close() {
      socket?.close(1000, "live test complete");
      control?.[Symbol.dispose]();
      await observing?.catch(() => {});
    }
  };
}
