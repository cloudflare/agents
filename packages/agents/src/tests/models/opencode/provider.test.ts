import type { Plugin } from "@opencode/plugin";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "../../../models/opencode";
import { asAi, fakeBinding, jsonResponse } from "../ai-sdk/helpers";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

const answer = {
  choices: [
    { finish_reason: "stop", message: { role: "assistant", content: "ok" } }
  ]
};

/** The base URL OpenCode's Workers AI provider is pointed at. */
function baseURL(config: Record<string, unknown>): string {
  return (config.settings as { baseURL: string }).baseURL;
}

/** Start the provider's plugin, as OpenCode does when it boots. */
async function start(plugin: Plugin.Plugin) {
  const cleanup = await plugin.setup({} as Plugin.Context);
  return async () => {
    if (typeof cleanup === "function") await cleanup();
  };
}

describe("createAI for OpenCode", () => {
  it("names models on OpenCode's own Workers AI provider", () => {
    const ai = createAI({ binding: asAi(fakeBinding(() => jsonResponse({}))) });

    expect(ai(MODEL)).toEqual({
      providerID: CLOUDFLARE_PROVIDER_ID,
      id: MODEL
    });
    expect(ai.model(MODEL)).toEqual(ai(MODEL));
    expect(ai.provider.id).toBe("cloudflare-workers-ai");
    expect(ai.provider.config).toMatchObject({
      package: "@opencode/ai/providers/cloudflare-workers-ai",
      settings: {
        apiKey: expect.any(String),
        baseURL: expect.stringMatching(
          /^https:\/\/workers-ai\.binding\.invalid\/[^/]+\/v1$/
        )
      },
      // A model asked for by id carries the output cap.
      models: { [MODEL]: { limit: { output: 4096 } } }
    });
  });

  it("answers OpenCode's requests from the binding, with the gateway", async () => {
    const binding = fakeBinding(() => jsonResponse(answer));
    const ai = createAI({ binding: asAi(binding), gateway: "prod" });
    const stop = await start(ai.provider.plugin);

    const response = await fetch(
      `${baseURL(ai.provider.config)}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "hello" }],
          stream: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    expect(binding.calls).toMatchObject([
      {
        model: MODEL,
        input: { messages: [{ role: "user", content: "hello" }] },
        options: { gateway: { id: "prod" }, returnRawResponse: true }
      }
    ]);
    await stop();
  });

  it("stops answering once OpenCode stops the plugin", async () => {
    const ai = createAI({
      binding: asAi(fakeBinding(() => jsonResponse(answer)))
    });
    const stop = await start(ai.provider.plugin);
    await stop();

    const response = await fetch(
      `${baseURL(ai.provider.config)}/chat/completions`,
      { method: "POST", body: JSON.stringify({ model: MODEL }) }
    );
    expect(response.status).toBe(404);
  });

  it("reports a binding that throws as an HTTP error OpenCode can read", async () => {
    const ai = createAI({
      binding: asAi(
        fakeBinding(() => {
          throw new Error("out of capacity");
        })
      )
    });
    const stop = await start(ai.provider.plugin);

    const response = await fetch(
      `${baseURL(ai.provider.config)}/chat/completions`,
      { method: "POST", body: JSON.stringify({ model: MODEL }) }
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("out of capacity") }
    });
    await stop();
  });
});
