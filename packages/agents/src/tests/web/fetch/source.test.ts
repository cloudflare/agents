import { describe, expect, it } from "vitest";
import {
  WebFetchError,
  createDirectWebFetch,
  type DirectWebFetchOptions
} from "../../../web/fetch";
import { countingStream, fakeAi, page, redirect, stubFetch } from "./helpers";

const MARKDOWN = "# Hello\n\nWorld.";

function source(
  routes: Parameters<typeof stubFetch>[0],
  options: Partial<DirectWebFetchOptions> = {}
) {
  const stub = stubFetch(routes);
  const ai = fakeAi();
  const webFetch = createDirectWebFetch({
    binding: ai.binding,
    fetch: stub.fetch,
    ...options
  });
  return { webFetch, seen: stub.seen, calls: ai.calls };
}

async function failure(promise: Promise<unknown>): Promise<WebFetchError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the fetch to fail");
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(WebFetchError);
  return error as WebFetchError;
}

describe("createDirectWebFetch", () => {
  it("GETs with manual redirects and the default headers", async () => {
    const { webFetch, seen } = source({
      "https://example.com/doc": page(
        MARKDOWN,
        "text/markdown; charset=utf-8",
        {
          headers: {
            etag: '"v1"',
            "x-markdown-tokens": "4",
            "set-cookie": "a=b"
          }
        }
      )
    });
    const output = await webFetch.fetch({ url: "https://example.com/doc" });
    expect(seen).toEqual([
      {
        url: "https://example.com/doc",
        method: "GET",
        redirect: "manual",
        headers: {
          accept:
            "text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.8, */*;q=0.5",
          "accept-language": "en",
          "user-agent":
            "Cloudflare-Agents (+https://github.com/cloudflare/agents)"
        }
      }
    ]);
    expect(output).toEqual({
      url: "https://example.com/doc",
      finalUrl: "https://example.com/doc",
      status: 200,
      contentType: "text/markdown",
      via: "markdown-negotiated",
      content: MARKDOWN,
      totalChars: MARKDOWN.length,
      title: "Hello",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        etag: '"v1"',
        "x-markdown-tokens": "4"
      },
      bytes: MARKDOWN.length,
      redirects: []
    });
  });

  it("sends a custom User-Agent", async () => {
    const { webFetch, seen } = source(
      { "https://example.com/": page("hi", "text/plain") },
      { userAgent: "MyBot/1.0" }
    );
    await webFetch.fetch({ url: "https://example.com/" });
    expect(seen[0].headers["user-agent"]).toBe("MyBot/1.0");
  });

  it("drops the fragment and reports the URL as requested, trimmed", async () => {
    const { webFetch, seen } = source({
      "https://example.com/a": page("hi", "text/plain")
    });
    const output = await webFetch.fetch({
      url: "  https://example.com/a#top\n"
    });
    expect(seen[0].url).toBe("https://example.com/a");
    expect(output.url).toBe("https://example.com/a#top");
    expect(output.finalUrl).toBe("https://example.com/a");
  });

  describe("input and URL policy", () => {
    it("rejects disallowed URLs without fetching", async () => {
      const { webFetch, seen } = source({});
      for (const url of [
        "http://localhost/",
        "http://169.254.169.254/",
        "file:///etc/passwd",
        "https://user:pw@example.com/"
      ]) {
        const error = await failure(webFetch.fetch({ url }));
        expect(error.code, url).toBe("web_fetch_disallowed_url");
        expect(error.retryable).toBe(false);
        expect(error.status).toBe(403);
      }
      expect(seen).toEqual([]);
    });

    it("applies allowedHosts and blockedHosts", async () => {
      const { webFetch } = source(
        { "https://docs.example.com/": page("ok", "text/plain") },
        { allowedHosts: ["*.example.com"], blockedHosts: ["bad.example.com"] }
      );
      await expect(
        webFetch.fetch({ url: "https://docs.example.com/" })
      ).resolves.toMatchObject({ content: "ok" });
      for (const url of ["https://bad.example.com/", "https://example.org/"]) {
        const error = await failure(webFetch.fetch({ url }));
        expect(error.code).toBe("web_fetch_disallowed_url");
      }
    });

    it("lets allowPrivateHosts reach localhost", async () => {
      const { webFetch } = source(
        { "http://localhost:8787/": page("local", "text/plain") },
        { allowPrivateHosts: true }
      );
      const output = await webFetch.fetch({ url: "http://localhost:8787/" });
      expect(output.content).toBe("local");
    });

    it("owns url and format validation: invalid_web_fetch_input", async () => {
      const { webFetch } = source({});
      for (const request of [
        { url: "" },
        { url: "   " },
        { url: "not a url" },
        { url: `https://example.com/${"a".repeat(2000)}` },
        { url: "https://example.com/", format: "html" as "raw" },
        { url: 7 as unknown as string }
      ]) {
        const error = await failure(webFetch.fetch(request));
        expect(error.code, JSON.stringify(request)).toBe(
          "invalid_web_fetch_input"
        );
        expect(error.status).toBe(400);
        expect(error.retryable).toBe(false);
      }
    });

    it("throws RangeError for invalid options", () => {
      // The tool shares these checks (see tool.test.ts); 20 hops is the cap.
      const { binding } = fakeAi();
      for (const maxRedirects of [-1, 21]) {
        expect(() => createDirectWebFetch({ binding, maxRedirects })).toThrow(
          RangeError
        );
      }
      expect(() =>
        createDirectWebFetch({ binding, maxRedirects: 20 })
      ).not.toThrow();
    });
  });

  describe("redirects", () => {
    it.each([301, 302, 303, 307, 308])(
      "follows a %i, keeping the headers",
      async (status) => {
        const { webFetch, seen } = source({
          "https://example.com/old": redirect("/new", status),
          "https://example.com/new": page("moved", "text/plain")
        });
        const output = await webFetch.fetch({ url: "https://example.com/old" });
        expect(output).toMatchObject({
          finalUrl: "https://example.com/new",
          redirects: ["https://example.com/old"],
          content: "moved"
        });
        expect(seen.map((r) => r.url)).toEqual([
          "https://example.com/old",
          "https://example.com/new"
        ]);
        expect(seen[1].headers).toEqual(seen[0].headers);
        expect(seen[1].redirect).toBe("manual");
      }
    );

    it("re-checks every hop against the policy", async () => {
      const { webFetch, seen } = source(
        {
          "https://example.com/": redirect("https://example.com/2"),
          "https://example.com/2": redirect("http://127.0.0.1/admin"),
          "https://example.com/away": redirect("https://evil.example.org/")
        },
        { allowedHosts: ["example.com"] }
      );
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_disallowed_redirect",
        status: 302,
        url: "https://example.com/2",
        retryable: false
      });
      expect(error.message).toContain("127.0.0.1");
      expect(seen).toHaveLength(2);
      const away = await failure(
        webFetch.fetch({ url: "https://example.com/away" })
      );
      expect(away.code).toBe("web_fetch_disallowed_redirect");
    });

    it("refuses an https to http downgrade", async () => {
      const { webFetch, seen } = source({
        "https://example.com/": redirect("http://example.com/plain"),
        "http://example.com/plain": page("plain", "text/plain")
      });
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_disallowed_redirect",
        status: 302,
        url: "https://example.com/",
        retryable: false
      });
      expect(error.message).toContain("downgrades https to http");
      expect(seen).toHaveLength(1);
    });

    it("stops a redirect loop", async () => {
      const { webFetch, seen } = source({
        "https://example.com/a": redirect("/b"),
        "https://example.com/b": redirect("/a")
      });
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/a" })
      );
      expect(error.code).toBe("web_fetch_too_many_redirects");
      expect(error.message).toContain("loop");
      expect(seen).toHaveLength(2);
    });

    it("follows up to maxRedirects hops and no more", async () => {
      const chain = (hops: number) => {
        const routes: Parameters<typeof stubFetch>[0] = {};
        for (let i = 0; i < hops; i++) {
          routes[`https://example.com/${i}`] = redirect(`/${i + 1}`);
        }
        routes[`https://example.com/${hops}`] = page("end", "text/plain");
        return routes;
      };
      const five = source(chain(5));
      const output = await five.webFetch.fetch({
        url: "https://example.com/0"
      });
      expect(output.redirects).toHaveLength(5);

      const six = source(chain(6));
      const error = await failure(
        six.webFetch.fetch({ url: "https://example.com/0" })
      );
      expect(error.code).toBe("web_fetch_too_many_redirects");
      expect(six.seen).toHaveLength(6);

      const none = source(chain(1), { maxRedirects: 0 });
      const noneError = await failure(
        none.webFetch.fetch({ url: "https://example.com/0" })
      );
      expect(noneError.code).toBe("web_fetch_too_many_redirects");
    });

    it("returns a 3xx without a Location as the page", async () => {
      const { webFetch } = source({
        "https://example.com/": page("see other", "text/plain", { status: 300 })
      });
      const output = await webFetch.fetch({ url: "https://example.com/" });
      expect(output).toMatchObject({ status: 300, content: "see other" });
    });
  });

  describe("body", () => {
    it("stops reading at maxBytes", async () => {
      const body = countingStream(100, 1000);
      const { webFetch } = source(
        {
          "https://example.com/big": () =>
            new Response(body.stream, {
              headers: { "content-type": "text/plain" }
            })
        },
        { maxBytes: 2500 }
      );
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/big" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_too_large",
        status: 200,
        contentType: "text/plain",
        retryable: false
      });
      expect(error.message).toContain("larger than 2500 bytes");
      expect(body.pulled()).toBeLessThan(10);
    });

    it("rejects a declared Content-Length over maxBytes before reading", async () => {
      const body = countingStream(5, 10);
      const { webFetch } = source(
        {
          "https://example.com/": () =>
            new Response(body.stream, {
              headers: { "content-type": "text/plain", "content-length": "51" }
            })
        },
        { maxBytes: 50 }
      );
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/" })
      );
      expect(error.code).toBe("web_fetch_too_large");
      expect(body.pulled()).toBeLessThanOrEqual(1);
    });

    it("accepts a body of exactly maxBytes", async () => {
      const { webFetch } = source(
        { "https://example.com/": page("a".repeat(50), "text/plain") },
        { maxBytes: 50 }
      );
      const output = await webFetch.fetch({ url: "https://example.com/" });
      expect(output.bytes).toBe(50);
    });

    it("decodes a legacy multi-byte charset from Content-Type", async () => {
      // 日本語 in Shift_JIS: workerd's TextDecoder must know the label, or
      // decoding falls back to UTF-8 and the model reads mojibake.
      const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
      const { webFetch } = source({
        "https://example.com/": page(sjis, "text/plain; charset=Shift_JIS")
      });
      const output = await webFetch.fetch({ url: "https://example.com/" });
      expect(output.content).toBe("日本語");
      expect(output.bytes).toBe(6);
    });

    it("sniffs a missing Content-Type", async () => {
      const { webFetch } = source({
        "https://example.com/": page("just text", undefined)
      });
      const output = await webFetch.fetch({ url: "https://example.com/" });
      expect(output).toMatchObject({ contentType: "text/plain", via: "text" });
    });

    it("sniffs application/octet-stream, reading text bodies", async () => {
      const { webFetch } = source({
        "https://example.com/notes.md": page(
          "# Notes\n\n- one",
          "application/octet-stream"
        ),
        "https://example.com/blob": page(
          new Uint8Array([1, 0, 2]),
          "application/octet-stream"
        )
      });
      const output = await webFetch.fetch({
        url: "https://example.com/notes.md"
      });
      expect(output).toMatchObject({
        contentType: "text/plain",
        via: "text",
        content: "# Notes\n\n- one"
      });
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/blob" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_unsupported_content_type",
        contentType: "application/octet-stream"
      });
    });
  });

  describe("HTTP errors", () => {
    it("returns a 404 with a textual body as a page", async () => {
      const { webFetch, calls } = source({
        "https://example.com/missing": page(
          "<title>Nope</title>gone",
          "text/html",
          {
            status: 404
          }
        )
      });
      const output = await webFetch.fetch({
        url: "https://example.com/missing"
      });
      expect(output).toMatchObject({
        status: 404,
        via: "converted",
        content: "# Converted page.html",
        title: "Nope"
      });
      expect(calls).toEqual([
        {
          name: "page.html",
          type: "text/html",
          text: "<title>Nope</title>gone"
        }
      ]);
    });

    it.each([
      ["an empty", null, "text/html", 404, false],
      ["a whitespace-only", "  \n", "text/plain", 410, false],
      ["a binary", new Uint8Array([1, 2]), "image/gif", 503, true]
    ] as const)(
      "fails an error with %s body",
      async (_label, body, type, status, retryable) => {
        const { webFetch } = source({
          "https://example.com/": page(body, type, { status })
        });
        const error = await failure(
          webFetch.fetch({ url: "https://example.com/" })
        );
        expect(error).toMatchObject({
          code: "web_fetch_http_error",
          status,
          retryable
        });
      }
    );

    it("reports a bot challenge as blocked instead of returning it", async () => {
      const { webFetch, calls } = source({
        "https://example.com/": page(
          "<html><title>Just a moment...</title><body>Checking</body></html>",
          "text/html",
          { status: 403, headers: { "cf-mitigated": "challenge" } }
        )
      });
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_blocked",
        status: 403,
        retryable: false,
        contentType: "text/html"
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("failures and cancellation", () => {
    it("reports a network failure as unavailable", async () => {
      const webFetch = createDirectWebFetch({
        binding: fakeAi().binding,
        fetch: async () => {
          throw new TypeError("Network connection lost.");
        }
      });
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_unavailable",
        retryable: true
      });
      expect(error.message).toContain("Network connection lost.");
    });

    it("reports a body that fails mid-read as unavailable", async () => {
      const webFetch = createDirectWebFetch({
        binding: fakeAi().binding,
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                c.error(new TypeError("connection reset"));
              }
            }),
            { headers: { "content-type": "text/plain" } }
          )
      });
      const error = await failure(
        webFetch.fetch({ url: "https://example.com/" })
      );
      expect(error).toMatchObject({
        code: "web_fetch_unavailable",
        retryable: true
      });
      expect(error.message).toContain("connection reset");
    });

    it("rejects with the signal's reason, before or during the fetch", async () => {
      let fetches = 0;
      const webFetch = createDirectWebFetch({
        binding: fakeAi().binding,
        // Never settles, ignoring the signal: the source must still reject.
        fetch: () => {
          fetches += 1;
          return new Promise<Response>(() => {});
        }
      });
      const reason = new Error("stop");
      const request = { url: "https://example.com/" };
      await expect(
        webFetch.fetch(request, { signal: AbortSignal.abort(reason) })
      ).rejects.toBe(reason);
      expect(fetches).toBe(0);

      const controller = new AbortController();
      const pending = webFetch.fetch(request, { signal: controller.signal });
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(fetches).toBe(1);
    });

    it("rejects with the signal's reason mid-body", async () => {
      const controller = new AbortController();
      const reason = new Error("cancelled mid-body");
      const webFetch = createDirectWebFetch({
        binding: fakeAi().binding,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("partial"));
                setTimeout(() => controller.abort(reason), 5);
              }
            }),
            { headers: { "content-type": "text/plain" } }
          )
      });
      await expect(
        webFetch.fetch(
          { url: "https://example.com/" },
          { signal: controller.signal }
        )
      ).rejects.toBe(reason);
    });

    it("stops waiting for toMarkdown on abort", async () => {
      const controller = new AbortController();
      const reason = new Error("cancelled during conversion");
      const stub = stubFetch({
        "https://example.com/": page("<p>x</p>", "text/html")
      });
      const { binding } = fakeAi(() => {
        setTimeout(() => controller.abort(reason), 5);
        return new Promise(() => {});
      });
      const webFetch = createDirectWebFetch({ binding, fetch: stub.fetch });
      await expect(
        webFetch.fetch(
          { url: "https://example.com/" },
          { signal: controller.signal }
        )
      ).rejects.toBe(reason);
    });
  });
});
