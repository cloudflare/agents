/**
 * The fake model: an Anthropic Messages endpoint that streams the script.
 *
 * Each room gets its own `Cell` Durable Object. It streams replies, counts
 * tool executions, and holds at configured checkpoints until the controller
 * releases them. Holding the stream is what makes a test deterministic: the
 * controller acts while the agent under test is parked at a known point.
 *
 * Requests must stream (`stream: true`).
 *
 *   POST /c/<room>/v1/messages        model requests (any path ending /messages)
 *   POST /c/<room>/tool               a server tool ran: { key }
 *   GET  /control/<room>              { paused, fired, requests, tools }
 *   POST /control/<room>/configure    { pauses: [{ id, drop? }], continuation? }
 *   POST /control/<room>/release      { id }
 */
import { DurableObject } from "cloudflare:workers";
import {
  type AnthropicRequest,
  type StreamItem,
  SCRIPT,
  toolCheckpoint,
  renderFallback,
  renderStep,
  resolveStep
} from "./script";

export type Pause = { id: string; drop?: boolean };

/**
 * How the model answers a harness that asks it to continue an interrupted
 * reply: with the rest of the step, or, like a model that ignores the
 * instruction, with the whole step again.
 */
export type Continuation = "faithful" | "restart";

export type ModelConfig = { pauses: Pause[]; continuation?: Continuation };

type Config = ModelConfig;

export type RequestLog = {
  at: number;
  turn?: string;
  step?: number;
  reason?: string;
  outcome?: "completed" | "dropped" | "cancelled";
  /** The request continued an interrupted reply. */
  continued?: boolean;
  /** It continued by restarting the step (the `restart` continuation). */
  restarted?: boolean;
  /** It asked to continue a reply that was already complete. */
  nothingLeft?: boolean;
  /** The conversation the harness sent, after the newest turn marker. */
  tail?: string[];
};

/** A compact view of the messages from the newest user turn on. */
function requestTail(body: AnthropicRequest): string[] {
  const messages = body.messages ?? [];
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && /\[t\d+\]/.test(JSON.stringify(m.content))) {
      start = i;
    }
  });
  return messages.slice(start).map((m) => {
    const parts =
      typeof m.content === "string"
        ? [`text:${m.content.slice(0, 40)}`]
        : m.content.map((p) =>
            p.type === "text"
              ? `text:${String(p.text).slice(0, 40)}`
              : p.type === "tool_use"
                ? `tool_use:${String(p.name)}`
                : p.type
          );
    return `${m.role}: ${parts.join(" | ")}`;
  });
}

export type CellState = {
  paused: string[];
  fired: string[];
  requests: RequestLog[];
  tools: Record<string, number>;
};

type Env = { Cell: DurableObjectNamespace<Cell> };

export class Cell extends DurableObject<Env> {
  /** Holds in progress. A stream and a tool can hold at the same time. */
  #paused = new Map<string, () => void>();

  #config(): Config {
    return this.ctx.storage.kv.get<Config>("config") ?? { pauses: [] };
  }

  #fired(): string[] {
    return this.ctx.storage.kv.get<string[]>("fired") ?? [];
  }

  #requests(): RequestLog[] {
    return this.ctx.storage.kv.get<RequestLog[]>("requests") ?? [];
  }

  #log(entry: RequestLog): number {
    const requests = this.#requests();
    requests.push(entry);
    this.ctx.storage.kv.put("requests", requests);
    return requests.length - 1;
  }

  #settle(index: number, outcome: RequestLog["outcome"]): void {
    const requests = this.#requests();
    if (requests[index]) requests[index].outcome = outcome;
    this.ctx.storage.kv.put("requests", requests);
  }

  state(): CellState {
    return {
      paused: [...this.#paused.keys()],
      fired: this.#fired(),
      requests: this.#requests(),
      tools: this.ctx.storage.kv.get<Record<string, number>>("tools") ?? {}
    };
  }

  configure(config: Config): CellState {
    this.ctx.storage.kv.put("config", config);
    return this.state();
  }

  release(id: string): CellState {
    const release = this.#paused.get(id);
    this.#paused.delete(id);
    release?.();
    return this.state();
  }

  /**
   * Whether the stream stops at this checkpoint. Each pause fires once, so a
   * harness that retries after a fault streams straight through.
   */
  async #checkpoint(id: string): Promise<"continue" | "drop"> {
    const pause = this.#config().pauses.find((p) => p.id === id);
    if (!pause) return "continue";
    const fired = this.#fired();
    if (fired.includes(id)) return "continue";
    fired.push(id);
    this.ctx.storage.kv.put("fired", fired);
    if (pause.drop) return "drop";
    await new Promise<void>((resolve) => {
      this.#paused.set(id, resolve);
    });
    return "continue";
  }

  async tool(key: string): Promise<void> {
    const tools =
      this.ctx.storage.kv.get<Record<string, number>>("tools") ?? {};
    tools[key] = (tools[key] ?? 0) + 1;
    this.ctx.storage.kv.put("tools", tools);
    // Keys are unique across the script, so the key names the turn.
    const turn = SCRIPT.find((t) =>
      t.steps.some((s) =>
        s.blocks.some((b) => b.kind === "tool" && b.input.key === key)
      )
    );
    if (turn) await this.#checkpoint(toolCheckpoint(turn.id, key));
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as AnthropicRequest;
    if (body.stream !== true) {
      return Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "The fake model only streams: send `stream: true`."
          }
        },
        { status: 400 }
      );
    }
    const resolved = resolveStep(body);
    const restart = this.#config().continuation === "restart";
    const index = this.#log(
      resolved.ok
        ? {
            at: Date.now(),
            turn: resolved.turn.id,
            step: resolved.step,
            ...(resolved.resume && { continued: true }),
            ...(resolved.resume && restart && { restarted: true }),
            ...(resolved.nothingLeft && { nothingLeft: true }),
            tail: requestTail(body)
          }
        : { at: Date.now(), reason: resolved.reason, tail: requestTail(body) }
    );
    const items: StreamItem[] = resolved.ok
      ? restart && resolved.resume
        ? // Generated again from scratch, with new tool call IDs.
          renderStep(resolved.turn, resolved.step, undefined, index)
        : renderStep(resolved.turn, resolved.step, resolved.resume)
      : renderFallback(resolved.reason);

    const encoder = new TextEncoder();
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel: () => {
        cancelled = true;
      }
    });

    const pump = async () => {
      for (const item of items) {
        if (cancelled) {
          this.#settle(index, "cancelled");
          return;
        }
        if (item.type === "checkpoint") {
          if ((await this.#checkpoint(item.id)) === "drop") {
            this.#settle(index, "dropped");
            controller.error(new Error(`fake-model: dropped at ${item.id}`));
            return;
          }
          continue;
        }
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`
            )
          );
        } catch {
          this.#settle(index, "cancelled");
          return;
        }
        // Let each event reach the harness on its own.
        await scheduler.wait(5);
      }
      this.#settle(index, "completed");
      controller.close();
    };
    // The response outlives this call; the pump keeps writing to it.
    this.ctx.waitUntil(pump());

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      }
    });
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, area, room, ...rest] = url.pathname.split("/");
    if (!room) return json({ error: "no room" }, 404);
    const cell = env.Cell.getByName(decodeURIComponent(room));

    if (area === "c") {
      if (rest.at(-1) === "messages" && request.method === "POST") {
        return cell.fetch(request);
      }
      if (rest[0] === "tool" && request.method === "POST") {
        const { key } = (await request.json()) as { key: string };
        await cell.tool(key);
        return json({ ok: true });
      }
    }

    if (area === "control") {
      if (rest.length === 0 && request.method === "GET") {
        return json(await cell.state());
      }
      if (rest[0] === "configure" && request.method === "POST") {
        return json(await cell.configure((await request.json()) as Config));
      }
      if (rest[0] === "release" && request.method === "POST") {
        const { id } = (await request.json()) as { id: string };
        return json(await cell.release(id));
      }
    }

    return json({ error: "not found" }, 404);
  }
};
