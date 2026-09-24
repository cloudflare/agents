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
