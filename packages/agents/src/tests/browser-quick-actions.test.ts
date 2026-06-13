import { describe, expect, it } from "vitest";
import {
  browserContent,
  browserExtract,
  browserLinks,
  browserMarkdown,
  browserScrape,
  browserScreenshot,
  browserSnapshot,
  type QuickActionBinding
} from "../browser/quick-actions";
import { createQuickActionTools } from "../browser/ai";

type Call = { action: string; params: Record<string, unknown> };

function fakeBrowser(
  handler: (action: string, params: Record<string, unknown>) => Response
): { browser: QuickActionBinding; calls: Call[] } {
  const calls: Call[] = [];
  const browser: QuickActionBinding = {
    quickAction(action: string, params: Record<string, unknown>) {
      calls.push({ action, params });
      return Promise.resolve(handler(action, params));
    }
  };
  return { browser, calls };
}

function jsonResult(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { "content-type": "application/json" }
  });
}

type ToolExecute = (
  input: unknown,
  options: { toolCallId: string; messages: [] }
) => Promise<unknown>;

function runTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: ToolExecute }).execute;
  if (!execute) throw new Error("tool is not executable");
  return execute(input, { toolCallId: "t", messages: [] });
}

describe("quick action helpers", () => {
  it("returns markdown and sends the url to the markdown action", async () => {
    const { browser, calls } = fakeBrowser(() =>
      jsonResult("# Example\n\nbody")
    );

    const markdown = await browserMarkdown(browser, {
      url: "https://example.com"
    });

    expect(markdown).toBe("# Example\n\nbody");
    expect(calls[0]).toEqual({
      action: "markdown",
      params: { url: "https://example.com" }
    });
  });

  it("extracts structured data via the json action", async () => {
    const { browser, calls } = fakeBrowser(() =>
      jsonResult({ products: [{ name: "Workers" }] })
    );

    const data = await browserExtract<{ products: { name: string }[] }>(
      browser,
      {
        url: "https://example.com",
        prompt: "list products",
        response_format: {
          type: "json_schema",
          schema: { type: "object" }
        }
      }
    );

    expect(data.products[0].name).toBe("Workers");
    expect(calls[0].action).toBe("json");
    expect(calls[0].params.prompt).toBe("list products");
  });

  it("returns links as an array", async () => {
    const { browser } = fakeBrowser(() =>
      jsonResult(["https://a.com", "https://b.com"])
    );
    const links = await browserLinks(browser, { url: "https://example.com" });
    expect(links).toEqual(["https://a.com", "https://b.com"]);
  });

  it("returns screenshot bytes with their content type", async () => {
    const { browser } = fakeBrowser(
      () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" }
        })
    );

    const shot = await browserScreenshot(browser, {
      url: "https://example.com"
    });

    expect(shot.contentType).toBe("image/png");
    expect(Array.from(shot.data)).toEqual([137, 80, 78, 71]);
  });

  it("throws BrowserRenderingError on a non-ok response", async () => {
    const { browser } = fakeBrowser(
      () => new Response("nope", { status: 429 })
    );
    await expect(
      browserMarkdown(browser, { url: "https://example.com" })
    ).rejects.toMatchObject({
      name: "BrowserRenderingError",
      status: 429
    });
  });

  it("throws when the endpoint reports success: false", async () => {
    const { browser } = fakeBrowser(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "bad input" }]
          }),
          { headers: { "content-type": "application/json" } }
        )
    );
    await expect(
      browserMarkdown(browser, { url: "https://example.com" })
    ).rejects.toMatchObject({
      name: "BrowserRenderingError"
    });
  });

  it("surfaces the service's error message from a non-ok body", async () => {
    const { browser } = fakeBrowser(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "rate limited" }]
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
    );
    await expect(
      browserMarkdown(browser, { url: "https://example.com" })
    ).rejects.toThrow(/429.*rate limited/);
  });

  it("returns scrape elements with geometry and attributes", async () => {
    const { browser, calls } = fakeBrowser(() =>
      jsonResult([
        {
          selector: "h1",
          results: [
            {
              html: "<h1>Hi</h1>",
              text: "Hi",
              width: 100,
              height: 24,
              top: 0,
              left: 0,
              attributes: [{ name: "class", value: "title" }]
            }
          ]
        }
      ])
    );

    const scraped = await browserScrape(browser, {
      url: "https://example.com",
      elements: [{ selector: "h1" }]
    });

    expect(scraped[0].selector).toBe("h1");
    expect(scraped[0].results[0].text).toBe("Hi");
    expect(scraped[0].results[0].width).toBe(100);
    expect(calls[0].params.elements).toEqual([{ selector: "h1" }]);
  });

  it("returns content and snapshot results", async () => {
    const { browser: contentBrowser } = fakeBrowser(() =>
      jsonResult("<html>body</html>")
    );
    expect(
      await browserContent(contentBrowser, { url: "https://example.com" })
    ).toBe("<html>body</html>");

    const { browser: snapBrowser } = fakeBrowser(() =>
      jsonResult({ content: "<html></html>", screenshot: "aGk=" })
    );
    const snap = await browserSnapshot(snapBrowser, {
      url: "https://example.com"
    });
    expect(snap.content).toBe("<html></html>");
    expect(snap.screenshot).toBe("aGk=");
  });
});

describe("createQuickActionTools", () => {
  it("exposes the default text tool set", () => {
    const { browser } = fakeBrowser(() => jsonResult(""));
    const tools = createQuickActionTools({ browser });
    expect(Object.keys(tools).sort()).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
  });

  it("honors the actions allow-list, including opt-in content", () => {
    const { browser } = fakeBrowser(() => jsonResult(""));
    const tools = createQuickActionTools({
      browser,
      actions: ["markdown", "content"]
    });
    expect(Object.keys(tools).sort()).toEqual([
      "browser_content",
      "browser_markdown"
    ]);
  });

  it("truncates long markdown results to maxChars", async () => {
    const { browser } = fakeBrowser(() => jsonResult("x".repeat(100)));
    const tools = createQuickActionTools({ browser, maxChars: 10 });
    const result = (await runTool(tools.browser_markdown, {
      url: "https://example.com"
    })) as string;
    expect(result.startsWith("xxxxxxxxxx\n\n[truncated 90 characters]")).toBe(
      true
    );
  });

  it("maps the extract tool's schema onto response_format", async () => {
    const { browser, calls } = fakeBrowser(() => jsonResult({ ok: true }));
    const tools = createQuickActionTools({ browser });
    await runTool(tools.browser_extract, {
      url: "https://example.com",
      prompt: "grab it",
      schema: { type: "object" }
    });
    expect(calls[0].action).toBe("json");
    expect(calls[0].params.response_format).toEqual({
      type: "json_schema",
      schema: { type: "object" }
    });
  });

  it("maps the scrape tool's selectors onto elements", async () => {
    const { browser, calls } = fakeBrowser(() => jsonResult([]));
    const tools = createQuickActionTools({ browser });
    await runTool(tools.browser_scrape, {
      url: "https://example.com",
      selectors: ["h1", ".price"]
    });
    expect(calls[0].action).toBe("scrape");
    expect(calls[0].params.elements).toEqual([
      { selector: "h1" },
      { selector: ".price" }
    ]);
  });

  it("merges host options into every request without exposing them to the model", async () => {
    const { browser, calls } = fakeBrowser(() => jsonResult("# ok"));
    const tools = createQuickActionTools({
      browser,
      options: {
        authenticate: { username: "u", password: "p" },
        gotoOptions: { waitUntil: "networkidle0" }
      }
    });
    await runTool(tools.browser_markdown, { url: "https://example.com" });
    expect(calls[0].params).toEqual({
      url: "https://example.com",
      authenticate: { username: "u", password: "p" },
      gotoOptions: { waitUntil: "networkidle0" }
    });
  });

  it("keeps the per-call page alongside host options", async () => {
    const { browser, calls } = fakeBrowser(() => jsonResult("# ok"));
    const tools = createQuickActionTools({
      browser,
      options: { userAgent: "agents-test" }
    });
    await runTool(tools.browser_markdown, { url: "https://override.com" });
    expect(calls[0].params.url).toBe("https://override.com");
    expect(calls[0].params.userAgent).toBe("agents-test");
  });

  it("trims oversized arrays (links) but keeps them arrays", async () => {
    const many = Array.from({ length: 50 }, (_, i) => `https://x.com/${i}`);
    const { browser } = fakeBrowser(() => jsonResult(many));
    const tools = createQuickActionTools({ browser, maxChars: 100 });
    const result = (await runTool(tools.browser_links, {
      url: "https://example.com"
    })) as string[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThan(many.length);
    expect(result.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100);
    // The kept items are the originals, unchanged.
    expect(result[0]).toBe("https://x.com/0");
  });

  it("replaces an oversized object (extract) with a truncated preview note", async () => {
    const big = { blob: "y".repeat(500) };
    const { browser } = fakeBrowser(() => jsonResult(big));
    const tools = createQuickActionTools({ browser, maxChars: 50 });
    const result = (await runTool(tools.browser_extract, {
      url: "https://example.com",
      prompt: "grab it"
    })) as { truncated: boolean; note: string; preview: string };
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/too large/);
    expect(result.preview.length).toBeLessThanOrEqual(51);
  });

  it("summarizes an array whose first item alone overflows the budget", async () => {
    // A single scrape element bigger than maxChars: trimming yields [], which
    // would read as "no matches" — so it degrades to the truncated-preview note.
    const huge = [{ selector: "h1", html: "z".repeat(500) }];
    const { browser } = fakeBrowser(() => jsonResult(huge));
    const tools = createQuickActionTools({ browser, maxChars: 50 });
    const result = (await runTool(tools.browser_scrape, {
      url: "https://example.com",
      selectors: ["h1"]
    })) as { truncated: boolean; note: string };
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/too large/);
  });

  it("returns small results unchanged when within budget", async () => {
    const { browser } = fakeBrowser(() => jsonResult(["https://a.com"]));
    const tools = createQuickActionTools({ browser, maxChars: 1000 });
    const result = await runTool(tools.browser_links, {
      url: "https://example.com"
    });
    expect(result).toEqual(["https://a.com"]);
  });
});
