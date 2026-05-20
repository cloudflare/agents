/**
 * Tests for the run_puppeteer_script tool's execution pipeline.
 *
 * These tests prove the core concept: an agent-generated Puppeteer script
 * runs in a sandboxed Worker with the `page` object injected as an RPC
 * provider. The real Puppeteer page lives in the parent Worker; the script
 * in the sandbox calls it through the proxy.
 *
 * We mock the page methods here so the tests don't need a real browser.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor, type ResolvedProvider } from "@cloudflare/codemode";

/** Build the `page` provider that mirrors what server.ts injects. */
function makePageProvider(
  overrides: Partial<Record<string, (...args: unknown[]) => Promise<unknown>>>
): ResolvedProvider {
  const defaults: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    navigate: vi.fn(async () => undefined),
    title: vi.fn(async () => "Untitled"),
    url: vi.fn(async () => "https://example.com"),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => null),
    waitForSelector: vi.fn(async () => undefined),
    getText: vi.fn(async () => null),
    getTexts: vi.fn(async () => []),
    getAttr: vi.fn(async () => null),
  };
  return { name: "page", fns: { ...defaults, ...overrides } };
}

describe("run_puppeteer_script tool execution", () => {
  it("runs a multi-step QA script and returns structured data", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const gotoFn = vi.fn(async () => undefined);
    const titleFn = vi.fn(async () => "Welcome to Acme Co – We're Here to Help!");
    const getTextFn = vi.fn(async (selector: unknown) => {
      if (selector === "h1") return "Building Better Products Together";
      if (selector === "meta[name='description']") return null;
      return null;
    });
    const getTextsFn = vi.fn(async (selector: unknown) => {
      if (selector === "p") {
        return [
          "Join thousands of happy customers.",
          "Get started for free today.",
        ];
      }
      if (selector === "nav a") return ["Home", "Products", "About Us", "Contact"];
      return [];
    });
    const getAttrFn = vi.fn(async (selector: unknown, attr: unknown) => {
      if (selector === "meta[name='description']" && attr === "content") {
        return "Acme Co is dedicated to creating joyful user experiences";
      }
      return null;
    });

    const provider = makePageProvider({
      navigate: gotoFn,
      title: titleFn,
      getText: getTextFn,
      getTexts: getTextsFn,
      getAttr: getAttrFn,
    });

    // This is the kind of script the LLM would generate in response to
    // "check that this homepage has friendly, welcoming content"
    const script = `
async () => {
  await page.navigate("https://acme.example.com");
  const title = await page.title();
  const heading = await page.getText("h1");
  const paragraphs = await page.getTexts("p");
  const metaDesc = await page.getAttr("meta[name='description']", "content");
  const navItems = await page.getTexts("nav a");
  return { title, heading, paragraphs, metaDesc, navItems };
}`;

    const result = await executor.execute(script, [provider]);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      title: "Welcome to Acme Co – We're Here to Help!",
      heading: "Building Better Products Together",
      paragraphs: [
        "Join thousands of happy customers.",
        "Get started for free today.",
      ],
      metaDesc: "Acme Co is dedicated to creating joyful user experiences",
      navItems: ["Home", "Products", "About Us", "Contact"],
    });

    expect(gotoFn).toHaveBeenCalledWith("https://acme.example.com");
    expect(titleFn).toHaveBeenCalledTimes(1);
    expect(getAttrFn).toHaveBeenCalledWith("meta[name='description']", "content");
  });

  it("script can run page.evaluate with a JS string expression", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const evaluateFn = vi.fn(async (expression: unknown) => {
      // Simulate the browser evaluating different expressions
      if (expression === "document.querySelectorAll('a').length") return 12;
      if (expression === "document.title") return "My Page";
      if (expression === "Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim())") {
        return ["Section One", "Section Two", "Section Three"];
      }
      return null;
    });

    const provider = makePageProvider({ evaluate: evaluateFn });

    const script = `
async () => {
  await page.navigate("https://example.com");
  const linkCount = await page.evaluate("document.querySelectorAll('a').length");
  const title = await page.evaluate("document.title");
  const sections = await page.evaluate("Array.from(document.querySelectorAll('h2')).map(h => h.textContent.trim())");
  return { linkCount, title, sections };
}`;

    const result = await executor.execute(script, [provider]);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      linkCount: 12,
      title: "My Page",
      sections: ["Section One", "Section Two", "Section Three"],
    });
    expect(evaluateFn).toHaveBeenCalledTimes(3);
  });

  it("getText returns null for non-matching selectors without crashing", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const provider = makePageProvider({
      title: vi.fn(async () => "Some Page"),
      getText: vi.fn(async () => null),   // selector never matches
      getTexts: vi.fn(async () => []),    // no elements found
    });

    const script = `
async () => {
  await page.navigate("https://example.com");
  const title = await page.title();
  const banner = await page.getText(".hero-banner");
  const items = await page.getTexts(".carousel-item");
  return {
    title,
    hasBanner: banner !== null,
    itemCount: items.length,
  };
}`;

    const result = await executor.execute(script, [provider]);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      title: "Some Page",
      hasBanner: false,
      itemCount: 0,
    });
  });

  it("script can call page methods concurrently with Promise.all", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const callOrder: string[] = [];
    const provider = makePageProvider({
      title: vi.fn(async () => { callOrder.push("title"); return "Concurrent Page"; }),
      getText: vi.fn(async (sel: unknown) => {
        callOrder.push(`getText:${sel}`);
        return sel === "h1" ? "Big Heading" : null;
      }),
      getAttr: vi.fn(async (sel: unknown, attr: unknown) => {
        callOrder.push(`getAttr:${sel}`);
        return sel === "link[rel='canonical']" ? "https://example.com/canonical" : null;
      }),
    });

    const script = `
async () => {
  await page.navigate("https://example.com");
  const [title, heading, canonical] = await Promise.all([
    page.title(),
    page.getText("h1"),
    page.getAttr("link[rel='canonical']", "href"),
  ]);
  return { title, heading, canonical };
}`;

    const result = await executor.execute(script, [provider]);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      title: "Concurrent Page",
      heading: "Big Heading",
      canonical: "https://example.com/canonical",
    });
    // All three ran (order may vary due to Promise.all)
    expect(callOrder).toContain("title");
    expect(callOrder).toContain("getText:h1");
    expect(callOrder).toContain("getAttr:link[rel='canonical']");
  });

  it("script error is surfaced cleanly rather than hanging", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const provider = makePageProvider({
      getText: vi.fn(async () => {
        throw new Error("Element handle detached from the DOM");
      }),
    });

    const script = `
async () => {
  await page.navigate("https://example.com");
  const text = await page.getText(".detached");
  return { text };
}`;

    const result = await executor.execute(script, [provider]);

    expect(result.result).toBeUndefined();
    expect(result.error).toBe("Element handle detached from the DOM");
  });

  it("the script the agent writes matches what we document in the tool description", async () => {
    // This test uses exactly the example script from SCRIPT_DESCRIPTION in server.ts.
    // If someone changes the description example, this test will need to follow.
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const provider = makePageProvider({
      title: vi.fn(async () => "Example Domain"),
      getText: vi.fn(async (sel: unknown) =>
        sel === "h1" ? "Example Domain" : null
      ),
      getTexts: vi.fn(async () => [
        "This domain is for use in illustrative examples in documents.",
        "You may use this domain in literature without prior coordination.",
      ]),
      getAttr: vi.fn(async () => null),
    });

    const script = `
async () => {
  await page.navigate("https://example.com");
  const title = await page.title();
  const heading = await page.getText("h1");
  const paragraphs = await page.getTexts("p");
  const metaDesc = await page.getAttr("meta[name='description']", "content");
  return { title, heading, paragraphs, metaDesc };
}`;

    const result = await executor.execute(script, [provider]);

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      title: expect.any(String),
      heading: expect.any(String),
      paragraphs: expect.any(Array),
    });
  });
});
