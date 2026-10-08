import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WebFetchError,
  type WebFetchPage,
  type WebFetchSource
} from "../../../web/fetch";
import {
  WebFetchError as AiSdkWebFetchError,
  webFetchTool as aiSdkWebFetchTool
} from "../../../web/fetch/tools/ai-sdk";
import {
  WebFetchError as PiWebFetchError,
  webFetchTool as piWebFetchTool
} from "../../../web/fetch/tools/pi";
import {
  WebFetchError as TanStackWebFetchError,
  webFetchTool as tanstackWebFetchTool
} from "../../../web/fetch/tools/tanstack-ai";

const CONTENT = `${"a".repeat(30)}\n${"b".repeat(30)}`;

const PAGE: WebFetchPage = {
  url: "https://example.com/doc",
  finalUrl: "https://example.com/doc",
  status: 200,
  contentType: "text/html",
  via: "converted",
  content: CONTENT,
  totalChars: CONTENT.length,
  title: "Doc",
  headers: { "content-type": "text/html" },
  bytes: 120,
  redirects: []
};

const okSource: WebFetchSource = { fetch: async () => PAGE };
const failure = new WebFetchError("Fetching example.com: DNS lookup failed.", {
  status: 502,
  code: "web_fetch_unavailable",
  url: "https://example.com/doc"
});
const failingSource: WebFetchSource = {
  fetch: async () => {
    throw failure;
  }
};
const MODEL_FAILURE =
  "web_fetch could not fetch https://example.com/doc (Fetching example.com: DNS lookup failed). You may retry once after a short wait.";

const toolApi = {} as never;
const context = { abortSignal: undefined } as never;

describe("pi adapter", () => {
  it("is named web_fetch and replay-safe", () => {
    const tool = piWebFetchTool({ source: okSource });
    expect(tool.name).toBe("web_fetch");
    expect(tool.replay).toBe("safe");
  });

  it("returns the rendered window to the model and the output in details", async () => {
    const tool = piWebFetchTool({ source: okSource, pageChars: 35 });
    const result = await tool.execute(
      { url: "https://example.com/doc" },
      toolApi,
      context
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          "text/html → markdown · chars 0–31 of 61 · continue with offset=31"
        )
      }
    ]);
    const { content: _content, ...metadata } = PAGE;
    expect(result.details).toEqual({
      ok: true,
      output: {
        ...metadata,
        content: `${"a".repeat(30)}\n`,
        offset: 0,
        nextOffset: 31
      }
    });
  });

  it("returns failures as error results with the source's detail", async () => {
    const result = await piWebFetchTool({ source: failingSource }).execute(
      { url: "https://example.com/doc" },
      toolApi,
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: MODEL_FAILURE }]);
    expect(result.details).toEqual({
      ok: false,
      message: "Fetching example.com: DNS lookup failed.",
      status: 502,
      code: "web_fetch_unavailable",
      retryable: true,
      url: "https://example.com/doc"
    });
  });

  it("puts contentType in the details when the failure has one", async () => {
    const error = new WebFetchError("Markdown conversion failed.", {
      status: 200,
      code: "web_fetch_conversion_failed",
      url: "https://example.com/a.pdf",
      contentType: "application/pdf"
    });
    const result = await piWebFetchTool({
      source: {
        fetch: async () => {
          throw error;
        }
      }
    }).execute({ url: "https://example.com/a.pdf" }, toolApi, context);
    expect(result.details).toMatchObject({
      ok: false,
      code: "web_fetch_conversion_failed",
      contentType: "application/pdf"
    });
  });

  it("leaves url and contentType out of the details when the failure has none", async () => {
    const result = await piWebFetchTool({ source: okSource }).execute(
      { url: "https://example.com/doc", offset: -1 },
      toolApi,
      context
    );
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({
      ok: false,
      message: "offset must be an integer of 0 or more; got -1.",
      status: 400,
      code: "invalid_web_fetch_input",
      retryable: false
    });
  });

  it("describes url, offset, and format in its TypeBox schema", () => {
    const { properties, required } = piWebFetchTool({ source: okSource })
      .parameters as unknown as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(required).toEqual(["url"]);
    expect(properties.url).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 2000
    });
    expect(properties.offset).toMatchObject({ type: "integer", minimum: 0 });
    expect(JSON.stringify(properties.format)).toContain('"raw"');
  });
});

describe("AI SDK adapter", () => {
  it("returns the stored window and renders it with toModelOutput", async () => {
    const tool = aiSdkWebFetchTool({ source: okSource, pageChars: 35 });
    const output = await tool.execute(
      { url: "https://example.com/doc", offset: 31 },
      {}
    );
    expect(output).toMatchObject({
      content: "b".repeat(30),
      offset: 31,
      nextOffset: null,
      totalChars: 61
    });
    const model = tool.toModelOutput({ output });
    expect(model.type).toBe("text");
    expect(model.value).toContain("chars 31–61 of 61");
    expect(model.value).toContain(`\n${"b".repeat(30)}\n`);
  });

  it("throws a WebFetchError with the model's text and the source's error as cause", async () => {
    const error = await aiSdkWebFetchTool({ source: failingSource })
      .execute({ url: "https://example.com/doc" }, {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebFetchError);
    expect(error).toMatchObject({
      message: MODEL_FAILURE,
      code: "web_fetch_unavailable",
      status: 502,
      retryable: true
    });
    expect((error as Error).cause).toBe(failure);
  });
});

describe("TanStack AI adapter", () => {
  it("is named web_fetch by default, returns the rendered text", async () => {
    const tool = tanstackWebFetchTool({ source: okSource });
    expect(tool.name).toBe("web_fetch");
    expect(tanstackWebFetchTool({ source: okSource, name: "read" }).name).toBe(
      "read"
    );
    await expect(
      tool.execute?.({ url: "https://example.com/doc" })
    ).resolves.toContain(
      "web_fetch: https://example.com/doc · 200 · text/html → markdown"
    );
  });

  it("throws so TanStack AI reports an error result", async () => {
    const error = await tanstackWebFetchTool({ source: failingSource })
      .execute?.({ url: "https://example.com/doc" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebFetchError);
    expect(error).toMatchObject({
      code: "web_fetch_unavailable",
      message: MODEL_FAILURE
    });
  });
});

describe("all adapters", () => {
  it("validate the same input with zod", () => {
    for (const schema of [
      aiSdkWebFetchTool({ source: okSource }).inputSchema,
      tanstackWebFetchTool({ source: okSource }).inputSchema
    ]) {
      const zod = schema as z.ZodType;
      expect(zod.safeParse({ url: "https://example.com/" }).success).toBe(true);
      expect(
        zod.safeParse({
          url: "https://example.com/",
          offset: 10,
          format: "raw"
        }).success
      ).toBe(true);
      expect(zod.safeParse({ url: "" }).success).toBe(false);
      expect(
        zod.safeParse({ url: "https://example.com/", offset: -1 }).success
      ).toBe(false);
      expect(
        zod.safeParse({ url: "https://example.com/", format: "html" }).success
      ).toBe(false);
      expect(JSON.stringify(z.toJSONSchema(zod))).toContain("offset");
    }
  });

  it("forward each framework's abort signal to the source", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const source: WebFetchSource = {
      fetch: async (_request, options) => {
        signals.push(options?.signal);
        return PAGE;
      }
    };
    const input = { url: "https://example.com/doc" };
    const controller = new AbortController();
    const abortSignal = controller.signal;
    await piWebFetchTool({ source }).execute(input, toolApi, {
      abortSignal
    } as never);
    await aiSdkWebFetchTool({ source }).execute(input, { abortSignal });
    await tanstackWebFetchTool({ source }).execute?.(input, {
      abortSignal
    } as never);
    expect(signals).toHaveLength(3);
    controller.abort();
    expect(signals.every((signal) => signal?.aborted)).toBe(true);

    // An aborted call rejects with the reason instead of fetching.
    const reason = new Error("cancelled");
    const aborted = { abortSignal: AbortSignal.abort(reason) };
    await expect(
      piWebFetchTool({ source }).execute(input, toolApi, aborted as never)
    ).rejects.toBe(reason);
    await expect(
      aiSdkWebFetchTool({ source }).execute(input, aborted)
    ).rejects.toBe(reason);
    await expect(
      tanstackWebFetchTool({ source }).execute?.(input, aborted as never)
    ).rejects.toBe(reason);
    expect(signals).toHaveLength(3);
  });

  it("use the host's description", () => {
    const description = "Read our docs.";
    expect(piWebFetchTool({ source: okSource, description }).description).toBe(
      description
    );
    expect(
      aiSdkWebFetchTool({ source: okSource, description }).description
    ).toBe(description);
    expect(
      tanstackWebFetchTool({ source: okSource, description }).description
    ).toBe(description);
  });

  it("re-export WebFetchError", () => {
    expect(PiWebFetchError).toBe(WebFetchError);
    expect(AiSdkWebFetchError).toBe(WebFetchError);
    expect(TanStackWebFetchError).toBe(WebFetchError);
  });
});
