import { expect } from "vitest";
import type { ChannelChunk, DeliveryResult } from "../src/channel";
import type {
  LiveDeliveryBinding,
  LiveStreamSession,
  ObservedMessage
} from "./binding";

const SETTLE_MS = 3_000;
const OBSERVATION_TIMEOUT_MS = 240_000;
const RUN_MARKER = `[channels-live:${crypto.randomUUID()}] `;

/** Keep repeated live runs distinct to providers that deduplicate traffic. */
export function uniqueText(text: string): string {
  return `${RUN_MARKER}${text}`;
}

export async function readObserved(
  channel: LiveDeliveryBinding
): Promise<ObservedMessage[]> {
  return (await channel.read()).map((message) => ({
    text: message.text.replaceAll(RUN_MARKER, "")
  }));
}

/** Run one scenario against an empty destination and leave it empty. */
export async function withDestination(
  create: () => LiveDeliveryBinding,
  run: (channel: LiveDeliveryBinding) => Promise<void>
): Promise<void> {
  const channel = create();
  await channel.open();
  try {
    expect(await readObserved(channel)).toEqual([]);
    await run(channel);
  } finally {
    try {
      await channel.clear();
      expect(await readObserved(channel)).toEqual([]);
    } finally {
      await channel.close?.();
    }
  }
}

/** Poll the destination until the expected text lands, or give up loudly. */
export async function readUntil(
  channel: LiveDeliveryBinding,
  expected: string
): Promise<ObservedMessage[]> {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
  let messages: ObservedMessage[] = [];
  while (Date.now() < deadline) {
    messages = await readObserved(channel);
    if (messages.some((message) => message.text.includes(expected))) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(
    messages.some((message) => message.text.includes(expected)),
    `${channel.name} never showed ${JSON.stringify(expected)}`
  ).toBe(true);
  // Settle, so a duplicate or a late edit shows up in the snapshot. Return
  // only this scenario's messages: Email Service may finish an earlier send
  // after that scenario's cleanup has already run.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return (await readObserved(channel)).filter((message) =>
    message.text.includes(expected)
  );
}

export async function snapshot(
  channel: LiveDeliveryBinding,
  scenario: string,
  observed: unknown
): Promise<void> {
  console.info(`[${channel.name}] ${scenario} ${JSON.stringify(observed)}`);
  await expect(`${JSON.stringify(observed, null, 2)}\n`).toMatchFileSnapshot(
    `./snapshots/${channel.name}-${scenario}.json`
  );
}

/** Drive one outbound stream by hand so tests can inspect intermediate state. */
export function chunkPump(
  run: (chunks: ReadableStream<ChannelChunk>) => Promise<DeliveryResult>
): LiveStreamSession {
  let controller!: ReadableStreamDefaultController<ChannelChunk>;
  const chunks = new ReadableStream<ChannelChunk>({
    start(streamController) {
      controller = streamController;
    }
  });
  const delivery = run(chunks);
  // Keep an early rejection from surfacing before the test calls finish/fail.
  delivery.catch(() => {});

  return {
    async push(chunk) {
      controller.enqueue(chunk);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    },
    finish() {
      controller.close();
      return delivery;
    },
    fail(reason) {
      controller.error(new Error(reason));
      return delivery;
    }
  };
}
