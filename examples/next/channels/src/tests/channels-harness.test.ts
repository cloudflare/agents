import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const stub = () => env.PI_CHANNELS_TEST.getByName(crypto.randomUUID());
const PNG = "iVBORw0KGgo=";

describe("piChannelsHarness input", () => {
  it("passes text and inline images to pi", async () => {
    const result = await stub().send(
      [
        { type: "text", text: "look" },
        {
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${PNG}`
        }
      ],
      "m1"
    );
    expect(JSON.parse(result)).toMatchObject({
      status: "done",
      text: "echo: look [image]"
    });
  });

  it("passes inline text files to pi as text", async () => {
    const result = await stub().send(
      [
        {
          type: "file",
          mediaType: "text/plain",
          url: `data:text/plain;base64,${btoa("notes")}`
        }
      ],
      "m1"
    );
    expect(JSON.parse(result)).toMatchObject({ text: "echo: notes" });
  });

  it("rejects attachments pi cannot take instead of dropping them", async () => {
    const pdf = await stub().send(
      [
        { type: "text", text: "summarize" },
        {
          type: "file",
          mediaType: "application/pdf",
          url: "data:application/pdf;base64,JVBERi0="
        }
      ],
      "m1"
    );
    expect(pdf).toMatch(/^rejected: .*application\/pdf/);
    const remote = await stub().send(
      [
        {
          type: "file",
          mediaType: "image/png",
          url: "https://example.com/a.png"
        }
      ],
      "m1"
    );
    expect(remote).toMatch(/^rejected: /);
  });
});

describe("piChannelsHarness forks", () => {
  it("keeps caller message ids on inherited user messages", async () => {
    const agent = stub();
    const root = await agent.rootId();
    await agent.send([{ type: "text", text: "one" }], "first", root);
    const fork = await agent.fork(root);
    await agent.send([{ type: "text", text: "two" }], "second", fork);
    expect(await agent.userIds(fork)).toEqual(["first", "second"]);
  });

  it("keeps them after eviction", async () => {
    const agent = stub();
    const root = await agent.rootId();
    await agent.send([{ type: "text", text: "one" }], "first", root);
    const fork = await agent.fork(root);
    await evictDurableObject(agent);
    expect(await agent.userIds(fork)).toEqual(["first"]);
  });
});
