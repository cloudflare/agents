import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import type {
  ChannelChunk,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelStreamOptions,
  DeliveryResult
} from "../../src/channel";
import { ChannelHost } from "../../src/host";
import type { ChannelMessageSurface } from "../../src/surface";
import { web } from "../../src/adapters/web";

type Env = {
  WEB_CHANNEL_LIVE: DurableObjectNamespace<WebChannelLiveObject>;
  LIVE_TEST_TOKEN?: string;
};

type StreamSession = {
  controller: ReadableStreamDefaultController<ChannelChunk>;
  delivery: Promise<DeliveryResult>;
};

class WebLiveControl extends RpcTarget {
  readonly #streams = new Map<string, StreamSession>();
  readonly #storage: DurableObjectStorage;
  readonly #host: () => ChannelHost;

  constructor(storage: DurableObjectStorage, host: () => ChannelHost) {
    super();
    this.#storage = storage;
    this.#host = host;
  }

  async surface(): Promise<ChannelMessageSurface | null> {
    return (await this.#storage.get<ChannelMessageSurface>("surface")) ?? null;
  }

  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult> {
    return this.#host().deliver(surface, message, options);
  }

  startStream(
    surface: ChannelMessageSurface,
    options?: ChannelStreamOptions
  ): { id: string } {
    const id = crypto.randomUUID();
    let controller!: ReadableStreamDefaultController<ChannelChunk>;
    const chunks = new ReadableStream<ChannelChunk>({
      start(streamController) {
        controller = streamController;
      }
    });
    const delivery = this.#host().stream(surface, chunks, options);
    this.#streams.set(id, { controller, delivery });
    return { id };
  }

  push(id: string, chunk: ChannelChunk): void {
    this.#session(id).controller.enqueue(chunk);
  }

  async finish(id: string): Promise<DeliveryResult> {
    const session = this.#session(id);
    session.controller.close();
    try {
      return await session.delivery;
    } finally {
      this.#streams.delete(id);
    }
  }

  async fail(id: string, reason: string): Promise<DeliveryResult> {
    const session = this.#session(id);
    session.controller.error(new Error(reason));
    try {
      return await session.delivery;
    } finally {
      this.#streams.delete(id);
    }
  }

  async clear(): Promise<void> {
    const deliveries: Promise<DeliveryResult>[] = [];
    for (const session of this.#streams.values()) {
      session.controller.error(new Error("Live-test destination cleared"));
      deliveries.push(session.delivery);
    }
    this.#streams.clear();
    await this.#storage.delete("surface");
    await Promise.allSettled(deliveries);
  }

  #session(id: string): StreamSession {
    const session = this.#streams.get(id);
    if (!session) throw new Error(`Unknown Web live-test stream ${id}`);
    return session;
  }
}

/** Bare Durable Object serving the live Web Channel contract fixture. */
export class WebChannelLiveObject extends DurableObject<Env> {
  readonly #control = new WebLiveControl(this.ctx.storage, () => this.#host);
  readonly #web = web({ webSockets: { callables: this.#control } });
  readonly #host = new ChannelHost({
    channels: { web: this.#web },
    onMessage: async ({ message }) => {
      if (!message.replySurface) {
        throw new Error(
          "Web live-test message did not include a reply surface"
        );
      }
      await this.ctx.storage.put("surface", message.replySurface);
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.#web.webSockets);
}

function localRequest(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("Web Channel live fixture");

    const suppliedToken = url.searchParams.get("token");
    if (env.LIVE_TEST_TOKEN) {
      if (suppliedToken !== env.LIVE_TEST_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    } else if (!localRequest(url)) {
      return new Response("LIVE_TEST_TOKEN is not configured", { status: 503 });
    }

    const name = url.searchParams.get("name");
    if (!name) return new Response("Missing object name", { status: 400 });
    const id = env.WEB_CHANNEL_LIVE.idFromName(name);
    return env.WEB_CHANNEL_LIVE.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;
