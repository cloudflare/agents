/** A client for the fake model's control API. */
import type { CellState, ModelConfig } from "./worker";

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

  /** The base URL to give an Anthropic client for this room. */
  baseUrl(room: string): string {
    return `${this.url}/c/${encodeURIComponent(room)}`;
  }

  /** What the room's model has seen: requests, fired and held checkpoints, tool counts. */
  state(room: string): Promise<CellState> {
    return this.#call(room);
  }

  /** Sets the room's holds, drops and continuation policy. */
  configure(room: string, config: ModelConfig): Promise<CellState> {
    return this.#call(room, "/configure", config);
  }

  /** Lets a held stream or tool go on past a checkpoint. */
  release(room: string, id: string): Promise<CellState> {
    return this.#call(room, "/release", { id });
  }

  async #call(room: string, rest = "", body?: unknown): Promise<CellState> {
    const url = `${this.url}/control/${encodeURIComponent(room)}${rest}`;
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
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
        `${body === undefined ? "GET" : "POST"} ${url}: ${response.status} ${(await response.text()).slice(0, 300)}`
      );
    }
    return (await response.json()) as CellState;
  }
}
