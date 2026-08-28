import { describe, expect, test } from "vitest";
import type { ChannelChunk } from "../src/channel";
import type { ObservedMessage } from "./binding";
import {
  chunkPump,
  readObserved,
  readUntil,
  snapshot,
  uniqueText,
  withDestination
} from "./helpers";
import { providers } from "./providers";

const STREAM_CHUNKS: readonly ChannelChunk[] = [
  { type: "text", text: uniqueText("Cloudflare Channels ") },
  { type: "text", text: "live streaming " },
  { type: "text", text: "smoke test." }
];

/**
 * Every chunk variant and the title, none of which the text-only smoke test
 * can produce. This is a request-shape test: Slack rejected an earlier title
 * with `streaming_mode_mismatch`, which no mock could catch.
 */
const RICH_CHUNKS: readonly ChannelChunk[] = [
  {
    type: "tool",
    name: "search",
    status: "started",
    title: "Searching docs",
    detail: "query: streaming"
  },
  { type: "text", text: uniqueText("Rich streaming ") },
  { type: "reasoning", text: "every Channel may ignore this" },
  {
    type: "tool",
    name: "search",
    status: "completed",
    title: "Searching docs"
  },
  { type: "text", text: "smoke test." },
  { type: "source", url: "https://example.com", title: "Example" }
];

describe("live channel streaming", () => {
  test.each(providers)("streams through %s", async (_name, create) => {
    await withDestination(create, async (channel) => {
      const session = chunkPump((chunks) =>
        channel.host.stream(channel.surface, chunks)
      );
      const duringStream: ObservedMessage[][] = [];
      for (const chunk of STREAM_CHUNKS) {
        await session.push(chunk);
        duringStream.push(await readObserved(channel));
      }
      const result = await session.finish();
      expect(result.status).toBe("delivered");

      const complete = "Cloudflare Channels live streaming smoke test.";
      await snapshot(channel, "stream", {
        duringStream,
        afterStream: await readUntil(channel, complete),
        ...(channel.previews && { previews: channel.previews() })
      });
    });
  });

  test.each(providers)(
    "streams every chunk variant through %s",
    async (_name, create) => {
      await withDestination(create, async (channel) => {
        const session = chunkPump((chunks) =>
          channel.host.stream(channel.surface, chunks, {
            title: "Live rich stream"
          })
        );
        for (const chunk of RICH_CHUNKS) await session.push(chunk);
        expect((await session.finish()).status).toBe("delivered");

        await snapshot(
          channel,
          "stream-rich",
          await readUntil(channel, "Rich streaming smoke test.")
        );
      });
    }
  );

  /**
   * A Channel must finalize after an abnormal ending too. Telegram is the
   * sharp case: its draft is not the message, so omitting the terminal
   * `sendMessage` leaves the chat empty when the draft expires.
   */
  test.each(providers)(
    "persists a partial answer when the generation fails through %s",
    async (_name, create) => {
      await withDestination(create, async (channel) => {
        const session = chunkPump((chunks) =>
          channel.host.stream(channel.surface, chunks)
        );
        await session.push({
          type: "text",
          text: uniqueText("The model started ")
        });
        await session.push({ type: "text", text: "answering and then " });
        const result = await session.fail("model failed mid-generation");

        expect(result.status).toBe("uncertain");
        expect(result).toHaveProperty("reference");
        await snapshot(
          channel,
          "stream-interrupted",
          await readUntil(channel, "The model started answering and then")
        );
      });
    }
  );
});
