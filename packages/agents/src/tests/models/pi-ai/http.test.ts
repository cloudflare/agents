/**
 * `createAI({ accountId, apiToken })` for pi-ai: a catalog id on the REST
 * API in the model's own format, a pi-ai model on the provider-native path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  anthropicModel,
  anthropicTextEvents,
  collectEvents,
  sseEventResponse,
  userContext
} from "./helpers";
import { headersOf, stubFetch } from "../fetch-stub";

const ACCOUNT = { accountId: "acct-1", apiToken: "token-1" } as const;

describe("pi-ai createAI over HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a catalog id on the REST API, in the model's own format", async () => {
    const calls = stubFetch(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI({ ...ACCOUNT, gateway: "project-gateway" });
    const { message } = await collectEvents(
      ai.streamSimple(ai("anthropic/claude-opus-4.8"), userContext("hi"))
    );
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/messages"
    );
    const headers = headersOf(calls[0]);
    expect(headers.authorization).toBe("Bearer token-1");
    expect(headers["cf-aig-gateway-id"]).toBe("project-gateway");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "anthropic/claude-opus-4.8"
    });
    expect(message.content).toEqual([{ text: "Hi there!", type: "text" }]);
  });

  it("sends a pi-ai model to the provider-native path with the token", async () => {
    const calls = stubFetch(() => sseEventResponse(anthropicTextEvents()));
    const ai = createAI(ACCOUNT);
    const { message } = await collectEvents(
      ai.streamSimple(ai(anthropicModel("claude-opus-4-8")), userContext("hi"))
    );
    expect(calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-1/default/anthropic/v1/messages"
    );
    const headers = headersOf(calls[0]);
    expect(headers["cf-aig-authorization"]).toBe("Bearer token-1");
    expect(message.content).toEqual([{ text: "Hi there!", type: "text" }]);
  });
});
