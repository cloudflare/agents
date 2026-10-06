/**
 * The fake model: an Anthropic Messages endpoint that streams a script.
 *
 * A test first creates a room with its script, holds and drops; the room's
 * base URL is then a model URL for the agent under test. Each room is a `Cell`
 * Durable Object. It streams replies, counts tool executions, and holds at
 * configured checkpoints until the test releases them. Holding the stream is
 * what makes a test deterministic: the test acts while the agent is parked at
 * a known point.
 *
 * Requests must stream (`stream: true`).
 *
 *   POST /rooms                          create: { id?, script?, pauses?, continuation? }
 *   GET  /rooms/<id>                     { paused, fired, requests, tools }
 *   POST /rooms/<id>/release             { checkpoint }
 *   POST /rooms/<id>/tool                a tool is running: { key }
 *   POST /rooms/<id>/v1/messages         model requests (any path ending /messages)
 */
import { DurableObject } from "cloudflare:workers";
import {
  type AnthropicRequest,
  type Script,
  type StreamItem,
  checkpointsOf,
  DEFAULT_SCRIPT,
  marksTurn,
  renderFallback,
  renderStep,
  resolveStep,
  scriptProblem,
  toolCheckpoint,
  turnForToolKey
} from "./script";

export type Pause = { id: string; drop?: boolean };

/**
 * How the model answers an agent that asks it to continue an interrupted
 * reply: with the rest of the step, or, like a model that ignores the
 * instruction, with the whole step again.
 */
export type Continuation = "faithful" | "restart";

/** What a room is created with. Everything is optional. */
export type RoomSpec = {
  /** Letters, digits, `.`, `_` and `-`. Generated if absent. */
  id?: string;
  /** Defaults to the built-in eight-turn script. */
  script?: Script;
  pauses?: Pause[];
  continuation?: Continuation;
};

export type Room = {
  id: string;
  /** The base URL to give an Anthropic client. */
  baseUrl: string;
  /** The script's checkpoints, in the order a run passes them. */
  checkpoints: string[];
};

type Config = {
  script: Script;
  pauses: Pause[];
  continuation: Continuation;
};

export type RequestLog = {
  at: number;
  turn?: string;
  step?: number;
  reason?: string;
  outcome?: "completed" | "dropped" | "cancelled" | "rejected";
  /** The request continued an interrupted reply. */
  continued?: boolean;
  /** It continued by restarting the step (the `restart` continuation). */
  restarted?: boolean;
  /** It asked to continue a reply that was already complete. */
  nothingLeft?: boolean;
  /** The conversation the agent sent, from the newest turn marker on. */
  tail?: string[];
};

/** A compact view of the messages from the newest user turn on. */
function requestTail(body: AnthropicRequest, script: Script): string[] {
  const messages = body.messages ?? [];
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && marksTurn(m.content, script)) start = i;
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

  /** Undefined until the room is created. */
  #config(): Config | undefined {
    return this.ctx.storage.kv.get<Config>("config");
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

  /** False if the room already exists. */
  create(config: Config): boolean {
    if (this.#config()) return false;
    this.ctx.storage.kv.put("config", config);
    return true;
  }

  state(): CellState | undefined {
    if (!this.#config()) return undefined;
    return {
      paused: [...this.#paused.keys()],
      fired: this.#fired(),
      requests: this.#requests(),
      tools: this.ctx.storage.kv.get<Record<string, number>>("tools") ?? {}
    };
  }

  release(id: string): CellState | undefined {
    const release = this.#paused.get(id);
    this.#paused.delete(id);
    release?.();
    return this.state();
  }

  /**
   * Whether the stream stops at this checkpoint. Each pause fires once, so an
   * agent that retries after a fault streams straight through.
   */
  async #checkpoint(id: string): Promise<"continue" | "drop"> {
    const pause = this.#config()?.pauses.find((p) => p.id === id);
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

  /** Logs a request the room has no route for. False if there is no room. */
  unrouted(method: string, path: string): boolean {
    if (!this.#config()) return false;
    this.#log({
      at: Date.now(),
      reason: `no route for ${method} ${path}`,
      outcome: "rejected"
    });
    return true;
  }

  /** False if the room does not exist. */
  async tool(key: string): Promise<boolean> {
    const config = this.#config();
    if (!config) return false;
    const tools =
      this.ctx.storage.kv.get<Record<string, number>>("tools") ?? {};
    tools[key] = (tools[key] ?? 0) + 1;
    this.ctx.storage.kv.put("tools", tools);
    const turn = turnForToolKey(config.script, key);
    if (turn) await this.#checkpoint(toolCheckpoint(turn.id, key));
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const config = this.#config();
    if (!config) {
      return anthropicError(
        404,
        "not_found_error",
        "No such room: create it with POST /rooms first."
      );
    }
    const body = (await request.json()) as AnthropicRequest;
    if (body.stream !== true) {
      this.#log({
        at: Date.now(),
        reason: "not streaming",
        outcome: "rejected",
        tail: requestTail(body, config.script)
      });
      return anthropicError(
        400,
        "invalid_request_error",
        "The fake model only streams: send `stream: true`."
      );
    }
    const { script } = config;
    const resolved = resolveStep(body, script);
    const restart = config.continuation === "restart";
    const index = this.#log(
      resolved.ok
        ? {
            at: Date.now(),
            turn: resolved.turn.id,
            step: resolved.step,
            ...(resolved.resume && { continued: true }),
            ...(resolved.resume && restart && { restarted: true }),
            ...(resolved.nothingLeft && { nothingLeft: true }),
            tail: requestTail(body, script)
          }
        : {
            at: Date.now(),
            reason: resolved.reason,
            tail: requestTail(body, script)
          }
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
        // Let each event reach the agent on its own.
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

function anthropicError(status: number, type: string, message: string) {
  return json({ type: "error", error: { type, message } }, status);
}

const ROOM_ID = /^[A-Za-z0-9._-]{1,128}$/;
const noRoom = () => json({ error: "no such room" }, 404);

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Why a create request is invalid, or the room's config. */
function parseSpec(
  value: unknown
): { error: string } | { id: string; config: Config } {
  const spec = (value ?? {}) as RoomSpec;
  if (typeof spec !== "object" || Array.isArray(spec)) {
    return { error: "body must be an object" };
  }
  const id = spec.id ?? crypto.randomUUID();
  if (typeof id !== "string" || !ROOM_ID.test(id)) {
    return { error: "id must be 1-128 letters, digits, ., _ or -" };
  }
  const script = spec.script ?? DEFAULT_SCRIPT;
  const problem = scriptProblem(script);
  if (problem) return { error: problem };
  const pauses = spec.pauses ?? [];
  if (!Array.isArray(pauses) || pauses.some((p) => typeof p?.id !== "string")) {
    return { error: "pauses must be an array of { id, drop? }" };
  }
  const continuation = spec.continuation ?? "faithful";
  if (continuation !== "faithful" && continuation !== "restart") {
    return { error: "continuation must be faithful or restart" };
  }
  return { id, config: { script, pauses, continuation } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, area, rawId, ...rest] = url.pathname.split("/");
    if (area !== "rooms") return json({ error: "not found" }, 404);

    if (!rawId) {
      if (request.method !== "POST") return json({ error: "not found" }, 404);
      const parsed = parseSpec(await readJson(request));
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      const created = await env.Cell.getByName(parsed.id).create(parsed.config);
      if (!created) return json({ error: `room ${parsed.id} exists` }, 409);
      const room: Room = {
        id: parsed.id,
        baseUrl: `${url.origin}/rooms/${parsed.id}`,
        checkpoints: checkpointsOf(parsed.config.script)
      };
      return json(room, 201);
    }

    const id = decodeURIComponent(rawId);
    if (!ROOM_ID.test(id)) return noRoom();
    const cell = env.Cell.getByName(id);

    if (rest.length === 0 && request.method === "GET") {
      const state = await cell.state();
      return state ? json(state) : noRoom();
    }
    if (request.method === "POST") {
      if (rest.at(-1) === "messages") return cell.fetch(request);
      if (rest.length === 1 && rest[0] === "release") {
        const { checkpoint } = ((await readJson(request)) ?? {}) as {
          checkpoint?: string;
        };
        if (typeof checkpoint !== "string") {
          return json({ error: "body must be { checkpoint }" }, 400);
        }
        const state = await cell.release(checkpoint);
        return state ? json(state) : noRoom();
      }
      if (rest.length === 1 && rest[0] === "tool") {
        const { key } = ((await readJson(request)) ?? {}) as { key?: string };
        if (typeof key !== "string") {
          return json({ error: "body must be { key }" }, 400);
        }
        return (await cell.tool(key)) ? json({ ok: true }) : noRoom();
      }
    }

    return (await cell.unrouted(request.method, url.pathname))
      ? json({ error: "not found" }, 404)
      : noRoom();
  }
};
