import { describe, expect, it } from "vitest";
import {
  WEB_FETCH_TOOL_DESCRIPTION,
  WebFetchError,
  type WebFetchErrorCode,
  type WebFetchPage,
  type WebFetchSource
} from "../../../web/fetch";
import {
  createWebFetchToolCore,
  describeFailureForModel,
  toolFailure,
  type WebFetchToolRun
} from "../../../web/fetch/tool";
import { fakeAi, page, stubFetch } from "./helpers";

const CONTENT = `${"a".repeat(30)}\n${"b".repeat(30)}\n${"c".repeat(10)}`;

function textPage(content = CONTENT): WebFetchPage {
  return {
    url: "https://example.com/doc",
    finalUrl: "https://example.com/doc",
    status: 200,
    contentType: "text/plain",
    via: "text",
    content,
    totalChars: content.length,
    headers: { "content-type": "text/plain" },
    bytes: content.length,
    redirects: []
  };
}

/** A source that returns `textPage()` and records each request. */
function recording(result: () => WebFetchPage = () => textPage()) {
  const requests: { url: string; format?: string; signal?: AbortSignal }[] = [];
  const source: WebFetchSource = {
    async fetch(request, options) {
      requests.push({ ...request, signal: options?.signal });
      return result();
    }
  };
  return { source, requests };
}

function failingWith(error: unknown): WebFetchSource {
  return {
    fetch: async () => {
      throw error;
    }
  };
}

const hangUntilAborted: WebFetchSource["fetch"] = (_request, options) =>
  new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () =>
      reject(options.signal?.reason)
    );
  });

function failed(run: WebFetchToolRun): Extract<WebFetchToolRun, { ok: false }> {
  if (run.ok) throw new Error("expected a failed run");
  return run;
}

describe("createWebFetchToolCore options", () => {
  const { binding } = fakeAi();
  const { source } = recording();

  it("defaults the name, description, and window", () => {
    const core = createWebFetchToolCore({ source });
    expect(core.name).toBe("web_fetch");
    expect(core.description).toBe(WEB_FETCH_TOOL_DESCRIPTION);
    expect(core.pageChars).toBe(20_000);
  });

  it("uses the host's description override", () => {
    const core = createWebFetchToolCore({
      source,
      description: "Read our docs."
    });
    expect(core.description).toBe("Read our docs.");
  });

  it("rejects invalid host configuration when the tool is created", () => {
    for (const bad of [
      { source, pageChars: 0 },
      { source, pageChars: 1.5 },
      { source, timeoutMs: -1 },
      { source, timeoutMs: Number.NaN },
      { source, description: "  " },
      { binding, maxBytes: 0 },
      { binding, maxRedirects: -1 },
      { binding, allowedHosts: ["http://example.com/"] },
      { binding, userAgent: "" }
    ]) {
      expect(() => createWebFetchToolCore(bad), JSON.stringify(bad)).toThrow(
        RangeError
      );
    }
  });

  it("needs exactly one of binding or source", () => {
    expect(() => createWebFetchToolCore({} as never)).toThrow(
      /Pass `binding`.*or a `source`/
    );
    expect(() => createWebFetchToolCore({ binding, source } as never)).toThrow(
      "Pass `binding` or `source`, not both."
    );
    expect(() =>
      createWebFetchToolCore({ source: {} as WebFetchSource })
    ).toThrow("source must have a fetch() method.");
  });

  it("builds a direct source from binding", async () => {
    const stub = stubFetch({
      "https://example.com/": page("hello", "text/plain")
    });
    const run = await createWebFetchToolCore({
      binding,
      fetch: stub.fetch
    }).run({
      url: "https://example.com/"
    });
    expect(run.ok && run.output).toMatchObject({
      content: "hello",
      via: "text"
    });
    expect(stub.seen).toHaveLength(1);
  });
});

describe("createWebFetchToolCore input", () => {
  it("passes url and format to the source, which validates them", async () => {
    const { source, requests } = recording();
    await createWebFetchToolCore({ source }).run({
      url: "https://example.com/doc",
      format: "raw"
    });
    expect(requests).toMatchObject([
      { url: "https://example.com/doc", format: "raw" }
    ]);
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a bad offset as invalid_web_fetch_input without fetching", async () => {
    const { source, requests } = recording();
    const core = createWebFetchToolCore({ source });
    for (const offset of [-1, 1.5, "10"]) {
      const run = failed(
        await core.run({ url: "https://example.com/", offset } as never)
      );
      expect(run.error, String(offset)).toMatchObject({
        status: 400,
        code: "invalid_web_fetch_input",
        retryable: false
      });
      expect(run.text).toMatch(
        /^web_fetch rejected the input \(offset must be .+\)\. Fix it and try again\.$/
      );
    }
    expect(requests).toHaveLength(0);
  });

  it("reports the direct source's URL errors to the model", async () => {
    const stub = stubFetch({});
    const core = createWebFetchToolCore({
      binding: fakeAi().binding,
      fetch: stub.fetch
    });
    const bad = failed(await core.run({ url: "not a url" }));
    expect(bad.error.code).toBe("invalid_web_fetch_input");
    expect(bad.text).toMatch(/^web_fetch rejected the input/);
    const local = failed(await core.run({ url: "http://localhost/" }));
    expect(local.error.code).toBe("web_fetch_disallowed_url");
    expect(stub.seen).toHaveLength(0);
  });
});

describe("createWebFetchToolCore paging", () => {
  const { source } = recording();
  const core = createWebFetchToolCore({ source, pageChars: 35 });

  it("stores only the window, and renders it for the model", async () => {
    const run = await core.run({ url: "https://example.com/doc" });
    if (!run.ok) throw run.error;
    expect(run.output).toMatchObject({
      content: `${"a".repeat(30)}\n`,
      totalChars: 72,
      offset: 0,
      nextOffset: 31
    });
    expect(run.text).toBe(
      [
        "web_fetch: https://example.com/doc · 200 · text/plain → text · chars 0–31 of 72 · continue with offset=31",
        "<untrusted_web_content>",
        `${"a".repeat(30)}\n`,
        "</untrusted_web_content>"
      ].join("\n")
    );
    expect(core.render(run.output)).toBe(run.text);
  });

  it("continues from offset", async () => {
    const second = await core.run({
      url: "https://example.com/doc",
      offset: 31
    });
    if (!second.ok) throw second.error;
    expect(second.output).toMatchObject({
      content: `${"b".repeat(30)}\n`,
      offset: 31,
      nextOffset: 62
    });

    const last = await core.run({ url: "https://example.com/doc", offset: 62 });
    if (!last.ok) throw last.error;
    expect(last.output).toMatchObject({ offset: 62, nextOffset: null });
    expect(last.text).toContain("chars 62–72 of 72\n");
  });

  it("bounds the output by pageChars, however large the body", async () => {
    const body = "word ".repeat(200_000); // 1 MB
    const stub = stubFetch({
      "https://example.com/big": page(body, "text/plain")
    });
    const run = await createWebFetchToolCore({
      binding: fakeAi().binding,
      fetch: stub.fetch,
      pageChars: 1_000
    }).run({ url: "https://example.com/big" });
    if (!run.ok) throw run.error;
    expect(run.output.totalChars).toBe(1_000_000);
    expect(run.output.content.length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(run.output).length).toBeLessThan(2_000);
    expect(run.text.length).toBeLessThan(1_300);
  });
});

describe("createWebFetchToolCore failures", () => {
  it("turns a source failure into a failed run instead of throwing", async () => {
    const error = new WebFetchError("Fetching example.com failed.", {
      status: 404,
      code: "web_fetch_http_error",
      url: "https://example.com/doc"
    });
    const run = failed(
      await createWebFetchToolCore({ source: failingWith(error) }).run({
        url: "https://example.com/doc"
      })
    );
    expect(run.error).toBe(error);
    expect(run.text).toBe(
      "https://example.com/doc answered HTTP 404 with no readable body. Do not retry it."
    );
  });

  it("wraps a non-WebFetchError as retryable web_fetch_unavailable", async () => {
    const cause = new TypeError("network down");
    const run = failed(
      await createWebFetchToolCore({ source: failingWith(cause) }).run({
        url: "https://example.com/doc"
      })
    );
    expect(run.error).toMatchObject({
      status: 502,
      code: "web_fetch_unavailable",
      retryable: true,
      url: "https://example.com/doc",
      message: "network down",
      cause
    });
    expect(run.text).toBe(
      "web_fetch could not fetch https://example.com/doc (network down). You may retry once after a short wait."
    );
  });

  it("fails a fetch that outlives timeoutMs as retryable web_fetch_timeout", async () => {
    const run = failed(
      await createWebFetchToolCore({
        source: { fetch: hangUntilAborted },
        timeoutMs: 10
      }).run({ url: "https://example.com/doc" })
    );
    expect(run.error).toMatchObject({
      status: 504,
      code: "web_fetch_timeout",
      retryable: true,
      url: "https://example.com/doc"
    });
    expect(run.error.timeoutMs).toBe(10);
    expect(run.text).toBe(
      "web_fetch timed out after 10 ms. You may retry once."
    );
  });

  it("times out a source that ignores the signal", async () => {
    const run = failed(
      await createWebFetchToolCore({
        source: { fetch: () => new Promise(() => {}) },
        timeoutMs: 10
      }).run({ url: "https://example.com/doc" })
    );
    expect(run.error.code).toBe("web_fetch_timeout");
  });

  it("rethrows the caller's abort reason instead of returning a failure", async () => {
    const { source, requests } = recording();
    const reason = new Error("user cancelled");
    const core = createWebFetchToolCore({ source });
    await expect(
      core.run(
        { url: "https://example.com/doc" },
        { signal: AbortSignal.abort(reason) }
      )
    ).rejects.toBe(reason);
    expect(requests).toHaveLength(0);

    const controller = new AbortController();
    const run = createWebFetchToolCore({
      source: { fetch: hangUntilAborted }
    }).run({ url: "https://example.com/doc" }, { signal: controller.signal });
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
  });
});

describe("describeFailureForModel", () => {
  const url = "https://example.com/doc";
  const error = (
    code: WebFetchErrorCode,
    status: number,
    message: string,
    extra: { contentType?: string; timeoutMs?: number; url?: string } = {
      url
    }
  ) => new WebFetchError(message, { code, status, ...extra });
  const retryOnce = "You may retry once after a short wait.";
  const cases: [WebFetchError, string][] = [
    [
      error("invalid_web_fetch_input", 400, "url must be a string.", {}),
      "web_fetch rejected the input (url must be a string). Fix it and try again."
    ],
    [
      error("web_fetch_disallowed_url", 403, "127.0.0.1 is not allowed."),
      "That URL can't be fetched here (127.0.0.1 is not allowed). Do not retry it."
    ],
    [
      error("web_fetch_disallowed_redirect", 302, `${url} redirected away.`),
      `${url} redirected away. Do not retry.`
    ],
    [
      error("web_fetch_too_many_redirects", 302, `${url} redirected 6 times.`),
      `${url} redirected 6 times. Do not retry.`
    ],
    [
      error("web_fetch_timeout", 504, "Slow.", { url, timeoutMs: 30_000 }),
      "web_fetch timed out after 30 s. You may retry once."
    ],
    [
      error("web_fetch_too_large", 200, `${url} is larger than 5 MB.`),
      `${url} is larger than 5 MB. Do not retry.`
    ],
    [
      error("web_fetch_unsupported_content_type", 200, "PNG.", {
        url,
        contentType: "image/png"
      }),
      `${url} is image/png, which can't be read as text. Do not retry it.`
    ],
    ...[502, 429, 408].map((status): [WebFetchError, string] => [
      error("web_fetch_http_error", status, "Failed."),
      `${url} answered HTTP ${status} with no readable body. ${retryOnce}`
    ]),
    [
      error("web_fetch_http_error", 403, "Forbidden."),
      `${url} answered HTTP 403 with no readable body. Do not retry it.`
    ],
    [
      error("web_fetch_conversion_failed", 200, "Failed.", {
        url,
        contentType: "text/html"
      }),
      `${url} could not be converted; retry once with format: "raw".`
    ],
    [
      error("web_fetch_conversion_failed", 200, "Failed.", {
        url,
        contentType: "application/pdf"
      }),
      `${url} (application/pdf) could not be converted to text. Do not retry it.`
    ],
    [
      error("web_fetch_unavailable", 502, "DNS lookup failed."),
      `web_fetch could not fetch ${url} (DNS lookup failed). ${retryOnce}`
    ]
  ];

  it.each(
    cases.map(([error, text]) => ({
      code: error.code,
      status: error.status,
      error,
      text
    }))
  )("$code ($status)", ({ error, text }) => {
    expect(describeFailureForModel(error)).toBe(text);
  });

  it("marks rate limits and request timeouts retryable, other 4xx not", () => {
    const retryable = (status: number) =>
      error("web_fetch_http_error", status, "x").retryable;
    expect([429, 408, 500, 404].map(retryable)).toEqual([
      true,
      true,
      true,
      false
    ]);
  });
});

describe("toolFailure", () => {
  it("carries the model's text as message and the source's error as cause", () => {
    const error = new WebFetchError("Can't read image/png.", {
      status: 200,
      code: "web_fetch_unsupported_content_type",
      url: "https://example.com/a.png",
      contentType: "image/png"
    });
    const failure = toolFailure({
      ok: false,
      error,
      text: describeFailureForModel(error)
    });
    expect(failure).toBeInstanceOf(WebFetchError);
    expect(failure).toMatchObject({
      name: "WebFetchError",
      message:
        "https://example.com/a.png is image/png, which can't be read as text. Do not retry it.",
      status: 200,
      code: "web_fetch_unsupported_content_type",
      retryable: false,
      url: "https://example.com/a.png",
      contentType: "image/png"
    });
    expect(failure.cause).toBe(error);
  });
});
