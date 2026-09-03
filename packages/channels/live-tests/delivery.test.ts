import { describe, expect, test } from "vitest";
import { emailBinding } from "./bindings/email";
import { slackBinding } from "./bindings/slack";
import { telegramBinding } from "./bindings/telegram";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const providers = [
  ["telegram", telegramBinding],
  ["slack", slackBinding],
  ["email", emailBinding]
] as const;

describe("live channel delivery", () => {
  test.each(providers)("delivers through %s", async (_name, create) => {
    const channel = create();
    console.info(`[${channel.name}] clearing ${channel.destination}`);
    await channel.open?.();

    try {
      await channel.clear();
      expect(await channel.read()).toEqual([]);

      const result = await channel.deliver(
        "Cloudflare Channels live delivery smoke test."
      );
      console.info(`[${channel.name}] ${JSON.stringify(result)}`);

      let messages = [];
      const deadline = Date.now() + 120_000;
      while (messages.length === 0 && Date.now() < deadline) {
        await sleep(1_000);
        messages = await channel.read();
      }
      expect(messages.length).toBeGreaterThan(0);

      await sleep(5_000);
      messages = await channel.read();
      console.info(`[${channel.name}] observed ${JSON.stringify(messages)}`);
      await expect(
        `${JSON.stringify(messages, null, 2)}\n`
      ).toMatchFileSnapshot(`./snapshots/${channel.name}.json`);
    } finally {
      try {
        await channel.clear();
        expect(await channel.read()).toEqual([]);
      } finally {
        await channel.close?.();
      }
    }
  });
});
