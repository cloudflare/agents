import type { UIMessageChunk } from "ai";
import { WebSocketChatTransport } from "agents/chat/transport";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  ChannelChunk,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelStreamOptions,
  DeliveryResult
} from "../../src/channel";
import type { ChannelMessageSurface } from "../../src/surface";
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

type WebLiveControl = {
  surface(): Promise<ChannelMessageSurface | null>;
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
  const socket = new URL(webSocketUrl(url));
  socket.searchParams.set("__agents_rpc", "capnweb");
  return socket.toString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * A live Web destination backed by a deployed bare Durable Object fixture.
 * The chat socket is the independent observer; a non-hibernating Cap'n Web
 * session makes the fixture's real ChannelHost perform each operation.
 */
export function webBinding(): LiveDeliveryBinding {
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
    async close() {
      socket?.close(1000, "live test complete");
      control?.[Symbol.dispose]();
      await observing?.catch(() => {});
    }
  };
}
