import { expect, test } from "vitest";
import { readUntil, uniqueText, withDestination } from "./helpers";
import { providers } from "./providers";

test.each(providers)("delivers through %s", async (_name, create) => {
  await withDestination(create, async (channel) => {
    const text = "Cloudflare Channels live delivery smoke test.";
    const result = await channel.host.deliver(channel.surface, {
      markdown: uniqueText(text)
    });
    console.info(`[${channel.name}] ${JSON.stringify(result)}`);
    expect(result.status).toBe("delivered");
    await expect(
      `${JSON.stringify(await readUntil(channel, text), null, 2)}\n`
    ).toMatchFileSnapshot(`./snapshots/${channel.name}.json`);
  });
});

test.each(providers)(
  "delivers rich content through %s",
  async (_name, create) => {
    await withDestination(create, async (channel) => {
      const result = await channel.host.deliver(channel.surface, {
        title: "Live rich delivery",
        markdown: uniqueText(
          "Rich delivery with **bold text**, [a link](https://example.com), and `code`."
        )
      });
      expect(result.status).toBe("delivered");
      await expect(
        `${JSON.stringify(await readUntil(channel, "Rich delivery"), null, 2)}\n`
      ).toMatchFileSnapshot(`./snapshots/${channel.name}-rich.json`);
    });
  }
);
