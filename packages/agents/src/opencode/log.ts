export type OpenCodeDurableEvent = {
  readonly type: string;
  readonly durable: {
    readonly aggregateID: string;
    readonly seq: number;
    readonly version: number;
  };
  readonly data: Record<string, unknown>;
  readonly created?: number;
};

export type OpenCodeLogSynced = {
  readonly type: "log.synced";
  readonly aggregateID: string;
  readonly seq?: number;
};

export type OpenCodeLogItem = OpenCodeDurableEvent | OpenCodeLogSynced;

export class OpenCodeLogPumps {
  readonly #controllers = new Map<string, AbortController>();

  has(key: string): boolean {
    return this.#controllers.has(key);
  }

  async start(
    key: string,
    initialize: (
      signal: AbortSignal
    ) => Promise<() => Promise<void>> | (() => Promise<void>),
    onError?: (error: unknown) => void | Promise<void>
  ): Promise<boolean> {
    if (this.#controllers.has(key)) return false;
    const controller = new AbortController();
    this.#controllers.set(key, controller);
    let run: () => Promise<void>;
    try {
      run = await initialize(controller.signal);
    } catch (error) {
      if (this.#controllers.get(key) === controller) {
        this.#controllers.delete(key);
      }
      controller.abort();
      throw error;
    }
    let work: Promise<void>;
    try {
      work = run();
    } catch (error) {
      work = Promise.reject(error);
    }
    void work
      .catch(async (error: unknown) => {
        if (!controller.signal.aborted) await onError?.(error);
      })
      .finally(() => {
        if (this.#controllers.get(key) === controller) {
          this.#controllers.delete(key);
        }
      });
    return true;
  }

  stopAll(): void {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
  }
}

export async function replayOpenCodeLog(options: {
  readonly after: number;
  readonly source: AsyncIterable<OpenCodeLogItem>;
  readonly project: (event: OpenCodeDurableEvent) => void | Promise<void>;
  readonly save: (seq: number) => void | Promise<void>;
}): Promise<void> {
  let cursor = options.after;
  for await (const item of options.source) {
    if (!("durable" in item)) continue;
    if (item.durable.seq <= cursor) continue;
    await options.project(item);
    await options.save(item.durable.seq);
    cursor = item.durable.seq;
  }
}
