import { WorkerEntrypoint } from "cloudflare:workers";
import {
  connect,
  acquire,
  type Browser,
  type Page,
  type BrowserWorker
} from "@cloudflare/playwright";

/**
 * Props passed to the BrowserLoopback via ctx.exports
 */
export interface BrowserLoopbackProps {
  sessionId: string;
}

/**
 * Result from browsing a URL
 */
export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  links?: Array<{ text: string; href: string }>;
}

/**
 * Result from taking a screenshot
 */
export interface ScreenshotResult {
  url: string;
  title: string;
  imageBase64: string;
  mimeType: "image/png";
  width: number;
  height: number;
}

/**
 * Action to perform on a page
 */
export interface BrowserAction {
  type: "click" | "type" | "press" | "wait" | "scroll" | "select";
  /** CSS selector for the target element */
  selector?: string;
  /** Text to type (for 'type' action) */
  text?: string;
  /** Key to press (for 'press' action) */
  key?: string;
  /** Milliseconds to wait (for 'wait' action) */
  ms?: number;
  /** Scroll direction (for 'scroll' action) */
  direction?: "up" | "down";
  /** Option value (for 'select' action) */
  value?: string;
}

/**
 * Result from interacting with a page
 */
export interface InteractionResult {
  url: string;
  title: string;
  actionsPerformed: string[];
  content: string;
  screenshot?: string;
}

/**
 * Error result from browser operations
 */
export interface BrowserError {
  error: string;
  code: "BROWSER_ERROR" | "NAVIGATION_ERROR" | "TIMEOUT" | "ELEMENT_NOT_FOUND";
}

/**
 * Browser operation log entry
 */
export interface BrowserLogEntry {
  timestamp: number;
  sessionId: string;
  operation: string;
  url: string;
  duration: number;
  error?: string;
}

/**
 * BrowserLoopback - Provides browser automation capabilities via Cloudflare Browser Rendering
 *
 * This loopback allows the agent to:
 * - Browse web pages and extract content
 * - Take screenshots
 * - Interact with pages (click, type, etc.)
 * - Scrape specific elements
 *
 * It uses @cloudflare/playwright under the hood with session reuse for performance.
 *
 * Documentation: https://developers.cloudflare.com/browser-rendering/playwright/
 */
export class BrowserLoopback extends WorkerEntrypoint<
  Env,
  BrowserLoopbackProps
> {
  // Browser session ID for reuse (per agent session)
  private static browserSessions: Map<string, string> = new Map();

  // Operation log
  private static operationLogs: Map<string, BrowserLogEntry[]> = new Map();

  // Default timeout for page operations
  private static readonly DEFAULT_TIMEOUT_MS = 30000;

  /**
   * Log a browser operation
   */
  private logOperation(entry: BrowserLogEntry): void {
    const sessionId = this.ctx.props.sessionId;
    let logs = BrowserLoopback.operationLogs.get(sessionId);
    if (!logs) {
      logs = [];
      BrowserLoopback.operationLogs.set(sessionId, logs);
    }
    logs.push(entry);

    // Keep only last 50 entries
    if (logs.length > 50) {
      logs.shift();
    }
  }

  /**
   * Get the browser binding from env
   */
  private getBrowserBinding(): BrowserWorker {
    return (this.env as { BROWSER: BrowserWorker }).BROWSER;
  }

  /**
   * Get or create a browser instance with session reuse
   */
  private async getBrowser(): Promise<Browser> {
    const agentSessionId = this.ctx.props.sessionId;
    const existingBrowserSessionId =
      BrowserLoopback.browserSessions.get(agentSessionId);
    const browserBinding = this.getBrowserBinding();

    // Try to reuse existing session
    if (existingBrowserSessionId) {
      try {
        return await connect(browserBinding, existingBrowserSessionId);
      } catch {
        // Session expired or invalid, will create new one
        BrowserLoopback.browserSessions.delete(agentSessionId);
      }
    }

    // Acquire new session
    const { sessionId: newBrowserSessionId } = await acquire(browserBinding);
    BrowserLoopback.browserSessions.set(agentSessionId, newBrowserSessionId);

    return await connect(browserBinding, newBrowserSessionId);
  }

  /**
   * Execute a function with a page, handling cleanup
   */
  private async withPage<T>(
    fn: (page: Page) => Promise<T>,
    url?: string
  ): Promise<T | BrowserError> {
    const startTime = Date.now();
    const operation = url ? `navigate:${url}` : "page-operation";

    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage();

      try {
        const result = await fn(page);

        this.logOperation({
          timestamp: startTime,
          sessionId: this.ctx.props.sessionId,
          operation,
          url: url ?? page.url(),
          duration: Date.now() - startTime
        });

        return result;
      } finally {
        await page.close();
        // Disconnect but keep session alive for reuse
        await browser.close();
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);

      this.logOperation({
        timestamp: startTime,
        sessionId: this.ctx.props.sessionId,
        operation,
        url: url ?? "unknown",
        duration: Date.now() - startTime,
        error: errorMessage
      });

      // Categorize error
      if (errorMessage.includes("timeout")) {
        return { error: errorMessage, code: "TIMEOUT" };
      }
      if (
        errorMessage.includes("net::") ||
        errorMessage.includes("Navigation")
      ) {
        return { error: errorMessage, code: "NAVIGATION_ERROR" };
      }
      if (
        errorMessage.includes("selector") ||
        errorMessage.includes("Element")
      ) {
        return { error: errorMessage, code: "ELEMENT_NOT_FOUND" };
      }

      return { error: errorMessage, code: "BROWSER_ERROR" };
    }
  }

  /**
   * Browse a URL and extract page content as text
   *
   * @param url - The URL to browse
   * @param options - Browse options
   * @returns Page content or error
   */
  async browse(
    url: string,
    options?: {
      /** Wait for network to be idle before extracting */
      waitForNetworkIdle?: boolean;
      /** Extract links from the page */
      extractLinks?: boolean;
      /** Maximum content length to return */
      maxContentLength?: number;
      /** CSS selector to focus extraction on */
      selector?: string;
    }
  ): Promise<BrowseResult | BrowserError> {
    return this.withPage(async (page) => {
      await page.goto(url, {
        waitUntil: options?.waitForNetworkIdle
          ? "networkidle"
          : "domcontentloaded",
        timeout: BrowserLoopback.DEFAULT_TIMEOUT_MS
      });

      const title = await page.title();

      // Extract content
      let content: string;
      if (options?.selector) {
        const element = await page.$(options.selector);
        content = element
          ? await element.innerText()
          : "Selector not found on page";
      } else {
        // Remove non-content elements and get text
        content = await page.evaluate(() => {
          // Remove scripts, styles, nav, footer, ads
          const removeSelectors = [
            "script",
            "style",
            "nav",
            "footer",
            "header",
            "aside",
            '[role="navigation"]',
            '[role="banner"]',
            '[role="contentinfo"]',
            ".advertisement",
            ".ad",
            "#cookie-banner"
          ];
          for (const sel of removeSelectors) {
            for (const el of document.querySelectorAll(sel)) {
              el.remove();
            }
          }
          return document.body.innerText;
        });
      }

      // Truncate if needed
      const maxLen = options?.maxContentLength ?? 50000;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + "\n\n[Content truncated...]";
      }

      // Extract links if requested
      let links: Array<{ text: string; href: string }> | undefined;
      if (options?.extractLinks) {
        links = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll("a[href]"));
          return anchors
            .map((a) => ({
              text: (a as HTMLAnchorElement).innerText.trim().slice(0, 100),
              href: (a as HTMLAnchorElement).href
            }))
            .filter((l) => l.text && l.href.startsWith("http"))
            .slice(0, 50);
        });
      }

      return {
        url: page.url(),
        title,
        content,
        links
      };
    }, url);
  }

  /**
   * Take a screenshot of a URL
   *
   * @param url - The URL to screenshot
   * @param options - Screenshot options
   * @returns Screenshot as base64 or error
   */
  async screenshot(
    url: string,
    options?: {
      /** Capture full page (scroll) */
      fullPage?: boolean;
      /** Viewport width */
      width?: number;
      /** Viewport height */
      height?: number;
      /** Wait for network idle */
      waitForNetworkIdle?: boolean;
    }
  ): Promise<ScreenshotResult | BrowserError> {
    return this.withPage(async (page) => {
      // Set viewport if specified
      if (options?.width || options?.height) {
        await page.setViewportSize({
          width: options.width ?? 1280,
          height: options.height ?? 720
        });
      }

      await page.goto(url, {
        waitUntil: options?.waitForNetworkIdle
          ? "networkidle"
          : "domcontentloaded",
        timeout: BrowserLoopback.DEFAULT_TIMEOUT_MS
      });

      const title = await page.title();
      const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

      const screenshot = await page.screenshot({
        fullPage: options?.fullPage ?? false,
        type: "png"
      });

      return {
        url: page.url(),
        title,
        imageBase64: Buffer.from(screenshot).toString("base64"),
        mimeType: "image/png",
        width: viewport.width,
        height: viewport.height
      };
    }, url);
  }

  /**
   * Interact with a page by performing actions
   *
   * @param url - Starting URL
   * @param actions - Actions to perform
   * @param options - Interaction options
   * @returns Interaction result or error
   */
  async interact(
    url: string,
    actions: BrowserAction[],
    options?: {
      /** Take screenshot after interactions */
      screenshotAfter?: boolean;
      /** Maximum content length */
      maxContentLength?: number;
    }
  ): Promise<InteractionResult | BrowserError> {
    return this.withPage(async (page) => {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: BrowserLoopback.DEFAULT_TIMEOUT_MS
      });

      const actionsPerformed: string[] = [];

      for (const action of actions) {
        try {
          switch (action.type) {
            case "click":
              if (!action.selector) {
                throw new Error("click action requires selector");
              }
              await page.click(action.selector, { timeout: 5000 });
              actionsPerformed.push(`Clicked: ${action.selector}`);
              break;

            case "type":
              if (!action.selector || action.text === undefined) {
                throw new Error("type action requires selector and text");
              }
              await page.fill(action.selector, action.text, { timeout: 5000 });
              actionsPerformed.push(
                `Typed "${action.text.slice(0, 20)}..." in ${action.selector}`
              );
              break;

            case "press":
              if (!action.key) {
                throw new Error("press action requires key");
              }
              await page.keyboard.press(action.key);
              actionsPerformed.push(`Pressed: ${action.key}`);
              break;

            case "wait": {
              const ms = action.ms ?? 1000;
              await page.waitForTimeout(ms);
              actionsPerformed.push(`Waited ${ms}ms`);
              break;
            }

            case "scroll": {
              const direction = action.direction ?? "down";
              await page.evaluate((dir) => {
                window.scrollBy(0, dir === "down" ? 500 : -500);
              }, direction);
              actionsPerformed.push(`Scrolled ${direction}`);
              break;
            }

            case "select":
              if (!action.selector || action.value === undefined) {
                throw new Error("select action requires selector and value");
              }
              await page.selectOption(action.selector, action.value, {
                timeout: 5000
              });
              actionsPerformed.push(
                `Selected "${action.value}" in ${action.selector}`
              );
              break;
          }
        } catch (e) {
          actionsPerformed.push(
            `Failed: ${action.type} - ${e instanceof Error ? e.message : String(e)}`
          );
          // Continue with other actions
        }
      }

      const title = await page.title();

      // Get final content
      let content = await page.evaluate(() => document.body.innerText);
      const maxLen = options?.maxContentLength ?? 10000;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + "\n\n[Content truncated...]";
      }

      // Optional screenshot
      let screenshot: string | undefined;
      if (options?.screenshotAfter) {
        const img = await page.screenshot({ type: "png" });
        screenshot = Buffer.from(img).toString("base64");
      }

      return {
        url: page.url(),
        title,
        actionsPerformed,
        content,
        screenshot
      };
    }, url);
  }

  /**
   * Scrape specific elements from a page
   *
   * @param url - The URL to scrape
   * @param selectors - CSS selectors to extract
   * @returns Scraped data or error
   */
  async scrape(
    url: string,
    selectors: Record<string, string>
  ): Promise<
    | { url: string; title: string; data: Record<string, string[]> }
    | BrowserError
  > {
    return this.withPage(async (page) => {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: BrowserLoopback.DEFAULT_TIMEOUT_MS
      });

      const title = await page.title();
      const data: Record<string, string[]> = {};

      for (const [key, selector] of Object.entries(selectors)) {
        const elements = await page.$$(selector);
        data[key] = await Promise.all(
          elements.slice(0, 50).map(async (el) => {
            const text = await el.innerText();
            return text.trim().slice(0, 500);
          })
        );
      }

      return {
        url: page.url(),
        title,
        data
      };
    }, url);
  }

  /**
   * Get the operation log for this session
   */
  async getLog(): Promise<BrowserLogEntry[]> {
    return BrowserLoopback.operationLogs.get(this.ctx.props.sessionId) ?? [];
  }

  /**
   * Clear the operation log for this session
   */
  async clearLog(): Promise<void> {
    BrowserLoopback.operationLogs.delete(this.ctx.props.sessionId);
  }

  /**
   * Close the browser session for this agent session
   */
  async closeSession(): Promise<void> {
    BrowserLoopback.browserSessions.delete(this.ctx.props.sessionId);
  }
}
