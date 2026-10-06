import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  WebSearchError,
  renderWebSearchResults,
  createAIWebSearch,
  createHTTPWebSearch,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchSource
} from "../websearch";
import { webSearchTool as aiSdkWebSearchTool } from "../websearch/tools/ai-sdk";
import { webSearchTool as piWebSearchTool } from "../websearch/tools/pi";
import { webSearchTool as tanstackWebSearchTool } from "../websearch/tools/tanstack-ai";
import { createWebSearchToolCore } from "../websearch/tool";

const RESPONSE: WebSearchResponse = {
  items: [
    {
      url: "https://blog.cloudflare.com/introducing-web-search-api/",
      title: "Introducing Web Search API via AI Gateway | Cloudflare Blog",
      description:
        "# Introducing Web Search API\n\n  Today,   we're announcing   Cloudflare's partnership with web search providers.",
      imageUrl: "https://blog.cloudflare.com/og.png",
      lastModifiedDate: "2026-10-02T14:16:00.000Z"
    },
    {
      url: "https://developers.cloudflare.com/ai-gateway/usage/web-search/",
      title: "  Web Search · Cloudflare AI Gateway docs  "
    }
  ],
  metadata: { query: "web search api", requestId: "req-1", latencyMs: 711 }
};

/** {@link RESPONSE} as a source returns it: titles trimmed. */
const READ_RESPONSE: WebSearchResponse = {
  ...RESPONSE,
  items: RESPONSE.items.map((item) => ({ ...item, title: item.title.trim() }))
};

// Error bodies as the live API returned them on 2026-10-05.
const PAYMENT_REQUIRED = {
  ok: false,
  error: {
    category: "gateway",
    code: "web_search_payment_required",
    status: 402,
    retryable: false,
    gatewayRequestId: "d51a8e10-8626-43fb-ab87-9b99ced441d9"
  }
};
const BYOK_NOT_CONFIGURED = {
  ok: false,
  error: {
    category: "credential",
    code: "web_search_byok_not_configured",
    status: 400,
    retryable: false,
    gatewayRequestId: "1a53627d-db48-4bf7-9e13-f3fa434a4f75"
  }
};
const VALIDATION_ENVELOPE = {
  success: false,
  errors: [{ code: 7000, message: "Invalid web search request body" }],
  messages: [
    {
      code: "too_big",
      maximum: 10,
      message: "Number must be less than or equal to 10",
      path: ["limit"]
    }
  ],
  result: null
};
const GATEWAY_MISSING = {
  success: false,
  result: [],
  messages: [],
  error: [
    {
      code: 2001,
      message: "Please configure AI Gateway in the Cloudflare dashboard"
    }
  ],
  name: "AiGatewayError",
  httpCode: 400,
  internalCode: 2001,
  message: "Please configure AI Gateway in the Cloudflare dashboard"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

type WebSearchBindingRequest = {
  gatewayId: string;
  query: string;
  limit?: number;
  provider?: string;
  byokAlias?: string;
};

/** A fake `Ai` binding recording `websearch` calls. */
function fakeAI(respond: (request: WebSearchBindingRequest) => Response) {
  const calls: WebSearchBindingRequest[] = [];
  const binding = {
    websearch: async (request: WebSearchBindingRequest) => {
      calls.push(request);
      return respond(request);
    }
  } as unknown as Ai;
  return { binding, calls };
}

describe("renderWebSearchResults", () => {
  it("numbers results, collapses whitespace, and trims descriptions", () => {
    const text = renderWebSearchResults(RESPONSE, { maxDescriptionChars: 40 });
    expect(text).toBe(
      [
        '2 results for "web search api":',
        "",
        "1. Introducing Web Search API via AI Gateway | Cloudflare Blog",
        "https://blog.cloudflare.com/introducing-web-search-api/",
        "# Introducing Web Search API Today, we'…",
        "Modified: 2026-10-02T14:16:00.000Z",
        "",
        "2. Web Search · Cloudflare AI Gateway docs",
        "https://developers.cloudflare.com/ai-gateway/usage/web-search/"
      ].join("\n")
    );
  });

  it("passes descriptions through whole when untrimmed", () => {
    const text = renderWebSearchResults(RESPONSE, {
      maxDescriptionChars: Infinity
    });
    expect(text).toContain("partnership with web search providers.");
    expect(text).not.toContain("…");
  });

  it("says so when there are no results", () => {
    expect(
      renderWebSearchResults({ items: [], metadata: RESPONSE.metadata })
    ).toBe('No results for "web search api".');
  });
});

describe("createAIWebSearch", () => {
  it("sends the host's gateway, provider, and alias with the model's query", async () => {
    const ai = fakeAI(() => json(RESPONSE));
    const source = createAIWebSearch({
      binding: ai.binding,
      gateway: "my-gateway",
      provider: "exa",
      byokAlias: "team-key"
    });
    await expect(
      source({ query: "web search api", limit: 3 })
    ).resolves.toEqual(READ_RESPONSE);
    expect(ai.calls).toEqual([
      {
        gatewayId: "my-gateway",
        query: "web search api",
        limit: 3,
        provider: "exa",
        byokAlias: "team-key"
      }
    ]);
    expect(source.provider).toBe("exa");
  });

  it("defaults the gateway to 'default', the limit to 5, and leaves provider to the platform", async () => {
    const ai = fakeAI(() => json(RESPONSE));
    const source = createAIWebSearch({ binding: ai.binding });
    await source({ query: "q" });
    expect(ai.calls[0]).toMatchObject({ gatewayId: "default", limit: 5 });
    expect(ai.calls[0].provider).toBeUndefined();
    expect(source.provider).toBeUndefined();
  });

  it("explains which runtime is needed when the binding has no websearch()", async () => {
    const source = createAIWebSearch({ binding: {} as Ai });
    const failure = source({ query: "q", limit: 5 });
    await expect(failure).rejects.toMatchObject({
      name: "WebSearchError",
      status: 501,
      code: "websearch_unsupported_runtime",
      retryable: false
    });
    await expect(failure).rejects.toThrow(/workerd 1\.20260924\.1/);
  });

  it("rejects bad requests before calling the API", async () => {
    const ai = fakeAI(() => json(RESPONSE));
    const source = createAIWebSearch({ binding: ai.binding });
    await expect(source({ query: "   ", limit: 5 })).rejects.toMatchObject({
      name: "WebSearchError",
      code: "invalid_web_search_input"
    });
    await expect(source({ query: "q", limit: 11 })).rejects.toBeInstanceOf(
      WebSearchError
    );
    await expect(
      source({ query: "a".repeat(1025), limit: 1 })
    ).rejects.toBeInstanceOf(WebSearchError);
    expect(ai.calls).toHaveLength(0);
  });

  it.each([
    [
      "gateway-native",
      PAYMENT_REQUIRED,
      402,
      {
        status: 402,
        code: "web_search_payment_required",
        retryable: false,
        requestId: "d51a8e10-8626-43fb-ab87-9b99ced441d9"
      },
      /no credits and no provider key/
    ],
    [
      "credential",
      BYOK_NOT_CONFIGURED,
      400,
      { status: 400, code: "web_search_byok_not_configured" },
      /BYOK key alias is not configured/
    ],
    [
      "validation envelope",
      VALIDATION_ENVELOPE,
      400,
      {
        status: 400,
        code: "invalid_web_search_input",
        apiCode: 7000,
        retryable: false
      },
      /Invalid web search request body; limit: Number must be less than or equal to 10/
    ],
    [
      "gateway configuration",
      GATEWAY_MISSING,
      400,
      {
        status: 400,
        code: "web_search_gateway_not_configured",
        apiCode: 2001,
        retryable: false
      },
      /configure AI Gateway/
    ]
  ])("maps %s errors", async (_label, body, status, expected, message) => {
    const ai = fakeAI(() => json(body, status));
    const source = createAIWebSearch({ binding: ai.binding });
    const error = await source({ query: "q", limit: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error).toMatchObject(expected);
    expect(error.message).toMatch(message);
  });

  it("treats a non-JSON failure as retryable when it's a server error", async () => {
    const ai = fakeAI(() => new Response("upstream down", { status: 502 }));
    const source = createAIWebSearch({ binding: ai.binding });
    await expect(source({ query: "q", limit: 1 })).rejects.toMatchObject({
      status: 502,
      code: "web_search_unavailable",
      retryable: true,
      message: expect.stringContaining("upstream down")
    });
  });

  it("treats rate limits and server errors with a JSON body as retryable", async () => {
    const rateLimited = createAIWebSearch({
      binding: fakeAI(() =>
        json(
          { success: false, errors: [{ code: 971, message: "Slow down" }] },
          429
        )
      ).binding
    });
    await expect(rateLimited({ query: "q" })).rejects.toMatchObject({
      status: 429,
      code: "web_search_rate_limited",
      apiCode: 971,
      retryable: true
    });
    const providerDown = createAIWebSearch({
      binding: fakeAI(() =>
        json(
          {
            ok: false,
            error: { code: "web_search_provider_error", status: 503 }
          },
          503
        )
      ).binding
    });
    await expect(providerDown({ query: "q" })).rejects.toMatchObject({
      status: 503,
      code: "web_search_provider_error",
      retryable: true
    });
  });

  it("keeps usable items from a 200 and drops or repairs the rest", async () => {
    const ai = fakeAI(() =>
      json({
        items: [
          { url: "https://a.example", title: "A", description: 42, extra: 1 },
          { url: "https://b.example" },
          { title: "no url" },
          "not an item",
          {
            url: "https://c.example",
            title: "  ",
            faviconUrl: "https://c.example/f.ico"
          }
        ],
        metadata: { latencyMs: "fast" }
      })
    );
    const source = createAIWebSearch({ binding: ai.binding });
    await expect(source({ query: "q" })).resolves.toEqual({
      items: [
        { url: "https://a.example", title: "A" },
        { url: "https://b.example", title: "https://b.example" },
        {
          url: "https://c.example",
          title: "https://c.example",
          faviconUrl: "https://c.example/f.ico"
        }
      ],
      metadata: { query: "q", requestId: "", latencyMs: 0 }
    });
  });

  it("stops waiting for the binding when the signal aborts", async () => {
    const ai = fakeAI(() => json(RESPONSE));
    const never = { websearch: () => new Promise<Response>(() => {}) };
    const source = createAIWebSearch({ binding: never as unknown as Ai });
    const controller = new AbortController();
    const search = source({ query: "q" }, { signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(search).rejects.toThrow("stop");
    expect(ai.calls).toHaveLength(0);
  });

  it("rejects a 200 that isn't a search response", async () => {
    const ai = fakeAI(() => json({ hello: "world" }));
    const source = createAIWebSearch({ binding: ai.binding });
    await expect(source({ query: "q", limit: 1 })).rejects.toBeInstanceOf(
      WebSearchError
    );
  });
});

describe("createHTTPWebSearch", () => {
  it("posts to the account's websearch endpoint with the gateway in the body", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const source = createHTTPWebSearch({
      accountId: "acct",
      apiToken: "tok",
      gateway: "gw",
      provider: "linkup",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return json(RESPONSE);
      }
    });
    await expect(source({ query: "q", limit: 2 })).resolves.toEqual(
      READ_RESPONSE
    );
    expect(requests[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/websearch/"
    );
    expect(requests[0].init.method).toBe("POST");
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe(
      "Bearer tok"
    );
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      query: "q",
      limit: 2,
      provider: "linkup",
      options: { gateway: { id: "gw" } }
    });
  });

  it("sends the BYOK alias, honours baseUrl, and forwards the signal", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const source = createHTTPWebSearch({
      accountId: "acct",
      apiToken: "tok",
      byokAlias: "team-key",
      baseUrl: "https://api.example.com",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return json(RESPONSE);
      }
    });
    const controller = new AbortController();
    await source({ query: "q" }, { signal: controller.signal });
    expect(requests[0].url).toBe(
      "https://api.example.com/client/v4/accounts/acct/ai/websearch/"
    );
    expect(requests[0].init.signal).toBe(controller.signal);
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      limit: 5,
      byokAlias: "team-key",
      options: { gateway: { id: "default" } }
    });
  });

  it("maps error envelopes and non-JSON failures from fetch", async () => {
    const failing = (response: () => Response) =>
      createHTTPWebSearch({
        accountId: "acct",
        apiToken: "tok",
        fetch: async () => response()
      });
    await expect(
      failing(() => json(PAYMENT_REQUIRED, 402))({ query: "q" })
    ).rejects.toMatchObject({
      status: 402,
      code: "web_search_payment_required",
      retryable: false
    });
    await expect(
      failing(() => json(VALIDATION_ENVELOPE, 400))({ query: "q" })
    ).rejects.toMatchObject({ code: "invalid_web_search_input" });
    await expect(
      failing(() => new Response("<html>bad gateway</html>", { status: 502 }))({
        query: "q"
      })
    ).rejects.toMatchObject({
      status: 502,
      code: "web_search_unavailable",
      retryable: true
    });
  });
});

describe("createWebSearchToolCore", () => {
  const recording = () => {
    const requests: WebSearchRequest[] = [];
    const source: WebSearchSource = async (request) => {
      requests.push(request);
      return RESPONSE;
    };
    return { requests, source };
  };

  it("uses the host limit by default and caps the model's limit to it", async () => {
    const { requests, source } = recording();
    const core = createWebSearchToolCore({ source, limit: 3 });
    await core.run({ query: "a" });
    await core.run({ query: "b", limit: 2 });
    await core.run({ query: "c", limit: 10 });
    expect(requests.map((r) => r.limit)).toEqual([3, 2, 3]);
  });

  it("clamps a host limit outside 1–10", () => {
    expect(
      createWebSearchToolCore({ source: recording().source, limit: 50 }).limit
    ).toBe(10);
    expect(
      createWebSearchToolCore({ source: recording().source, limit: 0 }).limit
    ).toBe(1);
    expect(createWebSearchToolCore({ source: recording().source }).limit).toBe(
      5
    );
  });

  it("returns the full response to the host and rendered text for the model", async () => {
    const core = createWebSearchToolCore({ source: recording().source });
    const run = await core.run({ query: "a" });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual(RESPONSE);
    expect(run.text).toContain('2 results for "web search api"');
  });

  it("records the source's provider on the output", async () => {
    const source = Object.assign(recording().source, {
      provider: "exa" as const
    });
    const run = await createWebSearchToolCore({ source }).run({ query: "a" });
    expect(run.ok && run.output.provider).toBe("exa");
  });

  it("turns a failed search into an error result instead of throwing", async () => {
    const source: WebSearchSource = async () => {
      throw new WebSearchError("No credits.", {
        status: 402,
        code: "web_search_payment_required"
      });
    };
    const run = await createWebSearchToolCore({ source }).run({ query: "a" });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.message).toBe("No credits.");
    expect(run.text).toBe(
      "Web search is unavailable here (web_search_payment_required). Do not retry; answer without it and say that web search was unavailable."
    );
  });

  it("tells the model to retry once for retryable failures", async () => {
    const source: WebSearchSource = async () => {
      throw new TypeError("socket hang up");
    };
    const run = await createWebSearchToolCore({ source }).run({ query: "a" });
    expect(!run.ok && run.error).toMatchObject({
      status: 500,
      code: "web_search_unavailable",
      retryable: true,
      message: "socket hang up"
    });
    expect(!run.ok && run.text).toBe(
      "Web search failed temporarily (web_search_unavailable). You may retry once."
    );
  });

  it("tells the model to fix a rejected query", async () => {
    const ai = fakeAI(() => json(RESPONSE));
    const core = createWebSearchToolCore({ binding: ai.binding });
    const run = await core.run({ query: "   " });
    expect(!run.ok && run.text).toBe(
      "Web search rejected the query (Query must not be empty). Fix the query and try again."
    );
    expect(ai.calls).toHaveLength(0);
  });

  it("fails a search that outlives timeoutMs as retryable", async () => {
    const source: WebSearchSource = (_request, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    const run = await createWebSearchToolCore({ source, timeoutMs: 10 }).run({
      query: "a"
    });
    expect(!run.ok && run.error).toMatchObject({
      status: 504,
      code: "web_search_timeout",
      retryable: true
    });
  });

  it("rethrows when the caller aborts instead of returning a failure", async () => {
    const source: WebSearchSource = (_request, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    const controller = new AbortController();
    const run = createWebSearchToolCore({ source }).run(
      { query: "a" },
      { signal: controller.signal }
    );
    controller.abort(new Error("user cancelled"));
    await expect(run).rejects.toThrow("user cancelled");
  });

  it("uses the host's description override", () => {
    const core = createWebSearchToolCore({
      source: recording().source,
      description: "Search our docs."
    });
    expect(core.description).toBe("Search our docs.");
  });
});

describe("adapters", () => {
  const okSource: WebSearchSource = async () => RESPONSE;
  const failingSource: WebSearchSource = async () => {
    throw new WebSearchError("no credits", {
      status: 402,
      code: "web_search_payment_required",
      requestId: "r"
    });
  };
  const toolApi = {} as never;
  const context = { abortSignal: undefined } as never;

  it("pi: text for the model, full output in details, replay-safe", async () => {
    const tool = piWebSearchTool({ source: okSource });
    expect(tool.name).toBe("websearch");
    expect(tool.replay).toBe("safe");
    const result = await tool.execute({ query: "a" }, toolApi, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("2 results") }
    ]);
    expect(result.details).toEqual({ ok: true, output: RESPONSE });
  });

  it("pi: failures are error results with the API's code", async () => {
    const tool = piWebSearchTool({ source: failingSource });
    const result = await tool.execute({ query: "a" }, toolApi, context);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(/^Web search is unavailable here/)
      }
    ]);
    expect(result.details).toEqual({
      ok: false,
      message: "no credits",
      status: 402,
      code: "web_search_payment_required",
      retryable: false,
      requestId: "r"
    });
  });

  it("ai-sdk: output is the response, toModelOutput renders it, failures throw", async () => {
    const tool = aiSdkWebSearchTool({
      source: okSource,
      maxDescriptionChars: 20
    });
    const output = await tool.execute({ query: "a" }, {});
    expect(output).toEqual(RESPONSE);
    const model = tool.toModelOutput({ output });
    expect(model.type).toBe("text");
    expect(model.value).toContain("# Introducing Web S…");
    const error = await aiSdkWebSearchTool({ source: failingSource })
      .execute({ query: "a" }, {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error).toMatchObject({
      code: "web_search_payment_required",
      message: expect.stringMatching(/^Web search is unavailable here/),
      cause: { message: "no credits" }
    });
  });

  it("pi and tanstack: trim descriptions to maxDescriptionChars", async () => {
    const pi = await piWebSearchTool({
      source: okSource,
      maxDescriptionChars: 20
    }).execute({ query: "a" }, toolApi, context);
    expect(pi.content).toEqual([
      { type: "text", text: expect.stringContaining("# Introducing Web S…") }
    ]);
    const tanstack = await tanstackWebSearchTool({
      source: okSource,
      maxDescriptionChars: 20
    }).execute?.({ query: "a" });
    expect(tanstack).toContain("# Introducing Web S…");
  });

  it("forwards each framework's abort signal to the source", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const source: WebSearchSource = async (_request, options) => {
      signals.push(options?.signal);
      return RESPONSE;
    };
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      piWebSearchTool({ source }).execute({ query: "a" }, toolApi, {
        abortSignal: controller.signal
      } as never)
    ).rejects.toThrow("cancelled");
    await expect(
      aiSdkWebSearchTool({ source }).execute(
        { query: "a" },
        { abortSignal: controller.signal }
      )
    ).rejects.toThrow("cancelled");
    await expect(
      tanstackWebSearchTool({ source }).execute?.({ query: "a" }, {
        abortSignal: controller.signal
      } as never)
    ).rejects.toThrow("cancelled");
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("tells the model the host's limit as the schema maximum", () => {
    const maximum = (limit?: number) =>
      (
        piWebSearchTool({ source: okSource, limit }).parameters.properties
          .limit as { maximum?: number }
      ).maximum;
    expect(maximum(3)).toBe(3);
    expect(maximum()).toBe(5);

    for (const schema of [
      aiSdkWebSearchTool({ source: okSource, limit: 3 }).inputSchema,
      tanstackWebSearchTool({ source: okSource, limit: 3 }).inputSchema
    ]) {
      const zod = schema as z.ZodType;
      expect(zod.safeParse({ query: "a", limit: 3 }).success).toBe(true);
      expect(zod.safeParse({ query: "a", limit: 4 }).success).toBe(false);
    }
  });

  it("tanstack: named websearch by default, returns the rendered text", async () => {
    const tool = tanstackWebSearchTool({ source: okSource });
    expect(tool.name).toBe("websearch");
    expect(
      tanstackWebSearchTool({ source: okSource, name: "search" }).name
    ).toBe("search");
    await expect(tool.execute?.({ query: "a" })).resolves.toContain(
      '2 results for "web search api"'
    );
  });

  it("tanstack: failures throw so TanStack AI reports an error result", async () => {
    const error = await tanstackWebSearchTool({ source: failingSource })
      .execute?.({ query: "a" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error).toMatchObject({
      code: "web_search_payment_required",
      message: expect.stringMatching(/^Web search is unavailable here/)
    });
  });
});
