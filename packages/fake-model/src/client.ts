/** A client for the fake model's HTTP API. */
import type { CellState, Room, RoomSpec } from "./worker";

export type ControlOptions = {
  /** Extra request headers, such as Access credentials, per URL. */
  headers?: (
    url: string
  ) => Promise<Record<string, string>> | Record<string, string>;
  /** Per-request timeout. Defaults to 30 seconds. */
  timeoutMs?: number;
};

export class ModelControl {
  constructor(
    readonly url: string,
    private readonly options: ControlOptions = {}
  ) {}

  /** Creates a room. Its `baseUrl` is the model URL for the agent under test. */
  create(spec: RoomSpec = {}): Promise<Room> {
    return this.#call("/rooms", spec);
  }

  /** The base URL to give an Anthropic client for a room. */
  baseUrl(room: string): string {
    return `${this.url}/rooms/${encodeURIComponent(room)}`;
  }

  /** What the room's model has seen: requests, fired and held checkpoints, tool counts. */
  state(room: string): Promise<CellState> {
    return this.#call(`/rooms/${encodeURIComponent(room)}`);
  }

  /** Lets a held stream or tool go on past a checkpoint. */
  release(room: string, checkpoint: string): Promise<CellState> {
    return this.#call(`/rooms/${encodeURIComponent(room)}/release`, {
      checkpoint
    });
  }

  async #call<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.url}${path}`;
    const method = body === undefined ? "GET" : "POST";
    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(await this.options.headers?.(url))
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    });
    if (!response.ok) {
      throw new Error(
        `${method} ${url}: ${response.status} ${(await response.text()).slice(0, 300)}`
      );
    }
    return (await response.json()) as T;
  }
}
