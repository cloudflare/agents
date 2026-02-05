/**
 * Agent Tools - Tool definitions for the LLM-powered coding agent
 *
 * These tools allow the LLM to interact with the codebase:
 * - bash: Execute shell commands
 * - readFile: Read file contents from Yjs storage
 * - writeFile: Write/create files in Yjs storage
 * - editFile: Search and replace in files
 * - listFiles: List all files in the project
 * - fetch: Make HTTP requests (with security controls)
 * - webSearch: Search the web using Brave Search
 * - browseUrl: Browse web pages and extract content
 * - screenshot: Take screenshots of web pages
 * - interactWithPage: Perform actions on web pages
 */

import { tool, jsonSchema } from "ai";
import type { YjsStorage } from "./yjs-storage";
import type { BashLoopback } from "./loopbacks/bash";
import type { FetchLoopback } from "./loopbacks/fetch";
import type { BraveSearchLoopback } from "./loopbacks/brave-search";

/**
 * Browser loopback interface (matches BrowserLoopback methods)
 * Defined here to avoid importing @cloudflare/playwright in test environments
 */
export interface BrowserLoopbackInterface {
  browse(
    url: string,
    options?: {
      waitForNetworkIdle?: boolean;
      extractLinks?: boolean;
      maxContentLength?: number;
      selector?: string;
    }
  ): Promise<
    | {
        url: string;
        title: string;
        content: string;
        links?: Array<{ text: string; href: string }>;
      }
    | { error: string; code: string }
  >;
  screenshot(
    url: string,
    options?: {
      fullPage?: boolean;
      width?: number;
      height?: number;
      waitForNetworkIdle?: boolean;
    }
  ): Promise<
    | {
        url: string;
        title: string;
        imageBase64: string;
        mimeType: string;
        width: number;
        height: number;
      }
    | { error: string; code: string }
  >;
  interact(
    url: string,
    actions: Array<{
      type: "click" | "type" | "press" | "wait" | "scroll" | "select";
      selector?: string;
      text?: string;
      key?: string;
      ms?: number;
      direction?: "up" | "down";
      value?: string;
    }>,
    options?: { screenshotAfter?: boolean; maxContentLength?: number }
  ): Promise<
    | {
        url: string;
        title: string;
        actionsPerformed: string[];
        content: string;
        screenshot?: string;
      }
    | { error: string; code: string }
  >;
  scrape(
    url: string,
    selectors: Record<string, string>
  ): Promise<
    | { url: string; title: string; data: Record<string, string[]> }
    | { error: string; code: string }
  >;
}

/**
 * Tool execution context passed from the Agent
 */
export interface ToolContext {
  storage: YjsStorage;
  bash: BashLoopback;
  fetch: FetchLoopback;
  braveSearch: BraveSearchLoopback;
  /** Browser is optional - only available when BROWSER binding exists */
  browser?: BrowserLoopbackInterface;
}

/**
 * Create the bash tool for executing shell commands
 */
export function createBashTool(ctx: ToolContext) {
  return tool({
    description: `Execute a bash command in the workspace. Use this to run shell commands like ls, cat, grep, npm, git, etc.

Available commands include standard Unix utilities. The filesystem persists within a session.

Examples:
- List files: ls -la
- Run tests: npm test
- Search code: grep -r "pattern" .
- Install packages: npm install package-name`,
    inputSchema: jsonSchema<{ command: string }>({
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The bash command to execute. Can include pipes, redirects, etc."
        }
      },
      required: ["command"]
    }),
    execute: async ({ command }) => {
      try {
        const result = await ctx.bash.exec(command);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        };
      } catch (e) {
        return {
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          exitCode: 1
        };
      }
    }
  });
}

/**
 * Create the readFile tool for reading file contents
 */
export function createReadFileTool(ctx: ToolContext) {
  return tool({
    description: `Read the contents of a file from the project. Returns the full file content as a string.

Use this to examine existing code, configuration files, or any text file in the project.`,
    inputSchema: jsonSchema<{ path: string }>({
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file path to read (relative to project root, e.g. 'src/index.ts')"
        }
      },
      required: ["path"]
    }),
    execute: async ({ path }) => {
      const content = ctx.storage.readFile(path);
      if (content === null) {
        return { error: `File not found: ${path}` };
      }
      return { content, path };
    }
  });
}

/**
 * Create the writeFile tool for creating/overwriting files
 */
export function createWriteFileTool(ctx: ToolContext) {
  return tool({
    description: `Write content to a file. Creates the file if it doesn't exist, or overwrites it if it does.

Use this to create new files or completely replace existing file contents.
For small edits to existing files, prefer using editFile instead.`,
    inputSchema: jsonSchema<{ path: string; content: string }>({
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file path to write (relative to project root, e.g. 'src/utils.ts')"
        },
        content: {
          type: "string",
          description: "The complete content to write to the file"
        }
      },
      required: ["path", "content"]
    }),
    execute: async ({ path, content }) => {
      const version = ctx.storage.writeFile(path, content);
      return { success: true, path, version };
    }
  });
}

/**
 * Create the editFile tool for search-and-replace edits
 */
export function createEditFileTool(ctx: ToolContext) {
  return tool({
    description: `Edit a file by replacing a specific string with new content. This is safer than writeFile for making targeted changes.

The search string must match exactly (including whitespace and indentation).
Use this for making precise edits to existing files.

Tips:
- Include enough context in the search string to make it unique
- Preserve indentation in both search and replace strings
- For multiple edits, call this tool multiple times`,
    inputSchema: jsonSchema<{ path: string; search: string; replace: string }>({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to edit (relative to project root)"
        },
        search: {
          type: "string",
          description:
            "The exact string to find and replace (must match exactly, including whitespace)"
        },
        replace: {
          type: "string",
          description: "The string to replace the search string with"
        }
      },
      required: ["path", "search", "replace"]
    }),
    execute: async ({ path, search, replace }) => {
      const version = ctx.storage.editFile(path, search, replace);
      if (version === null) {
        // Check if file exists
        const content = ctx.storage.readFile(path);
        if (content === null) {
          return { error: `File not found: ${path}` };
        }
        return {
          error: `Search string not found in ${path}. Make sure the search string matches exactly, including whitespace and indentation.`
        };
      }
      return { success: true, path, version };
    }
  });
}

/**
 * Create the listFiles tool for listing project files
 */
export function createListFilesTool(ctx: ToolContext) {
  return tool({
    description: `List all files in the project. Returns an array of file paths.

Use this to explore the project structure and discover what files exist.`,
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {}
    }),
    execute: async () => {
      const files = ctx.storage.listFiles();
      return { files };
    }
  });
}

/**
 * Create the fetch tool for making HTTP requests
 */
export function createFetchTool(ctx: ToolContext) {
  return tool({
    description: `Make an HTTP request to fetch data from the web. Only certain URLs are allowed for security.

Allowed URL prefixes:
- https://api.github.com/
- https://raw.githubusercontent.com/
- https://registry.npmjs.org/
- https://cdn.jsdelivr.net/
- https://unpkg.com/

Allowed methods: GET, HEAD, OPTIONS

Use this to fetch documentation, package info, or API data.`,
    inputSchema: jsonSchema<{
      url: string;
      method?: "GET" | "HEAD" | "OPTIONS";
      headers?: Record<string, string>;
    }>({
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "The URL to fetch"
        },
        method: {
          type: "string",
          enum: ["GET", "HEAD", "OPTIONS"],
          default: "GET",
          description: "HTTP method (default: GET)"
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional HTTP headers"
        }
      },
      required: ["url"]
    }),
    execute: async ({ url, method = "GET", headers }) => {
      const result = await ctx.fetch.request(url, { method, headers });
      if ("error" in result) {
        return { error: result.error, code: result.code };
      }
      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body
      };
    }
  });
}

/**
 * Create the webSearch tool for searching the web
 */
export function createWebSearchTool(ctx: ToolContext) {
  return tool({
    description: `Search the web using Brave Search. Use this to find current information, documentation, tutorials, API references, or research topics.

Returns web results with titles, URLs, descriptions, and optional extra snippets for more context.

The freshness filter helps find recent content:
- pd: Past day (24 hours)
- pw: Past week (7 days)  
- pm: Past month (31 days)
- py: Past year

Examples:
- "React useEffect best practices" - general documentation
- "TypeScript 5.4 new features" with freshness="pm" - recent updates
- "how to parse JSON in Cloudflare Workers" - specific platform docs`,
    inputSchema: jsonSchema<{
      query: string;
      freshness?: "pd" | "pw" | "pm" | "py";
      count?: number;
    }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query - be specific for better results"
        },
        freshness: {
          type: "string",
          enum: ["pd", "pw", "pm", "py"],
          description:
            "Filter by time: pd=past day, pw=past week, pm=past month, py=past year"
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "Number of results to return (1-10, default: 5)"
        }
      },
      required: ["query"]
    }),
    execute: async ({ query, freshness, count = 5 }) => {
      const result = await ctx.braveSearch.search(query, {
        freshness,
        count,
        extraSnippets: true
      });

      if ("error" in result) {
        return { error: result.error, code: result.code };
      }

      // Format results for the LLM
      return {
        query: result.query,
        totalResults: result.totalResults,
        results: result.results.map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          extraSnippets: r.extraSnippets,
          age: r.age
        }))
      };
    }
  });
}

/**
 * Create the newsSearch tool for finding recent news
 */
export function createNewsSearchTool(ctx: ToolContext) {
  return tool({
    description: `Search for recent news articles using Brave Search. Use this to find current events, announcements, or breaking news on a topic.

Returns news articles with titles, URLs, descriptions, publication age, and source information.

Examples:
- "OpenAI announcements" - recent AI news
- "TypeScript release" - language updates
- "Cloudflare new features" - platform news`,
    inputSchema: jsonSchema<{
      query: string;
      freshness?: "pd" | "pw" | "pm" | "py";
      count?: number;
    }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The news search query"
        },
        freshness: {
          type: "string",
          enum: ["pd", "pw", "pm", "py"],
          description:
            "Filter by time: pd=past day, pw=past week, pm=past month, py=past year"
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "Number of results to return (1-10, default: 5)"
        }
      },
      required: ["query"]
    }),
    execute: async ({ query, freshness, count = 5 }) => {
      const result = await ctx.braveSearch.news(query, {
        freshness,
        count
      });

      if ("error" in result) {
        return { error: result.error, code: result.code };
      }

      // Format results for the LLM
      return {
        query: result.query,
        results: result.results.map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          age: r.age,
          source: r.source.name
        }))
      };
    }
  });
}

/**
 * Create the browseUrl tool for reading web page content
 */
export function createBrowseUrlTool(ctx: ToolContext) {
  return tool({
    description: `Browse a URL and extract its content as text. The page is fully rendered (JavaScript executed) before extraction.

Use this to:
- Read documentation pages
- Extract content from tutorials or articles
- Get information from web pages that require JavaScript rendering

The content is cleaned (scripts, styles, navigation removed) for readability.`,
    inputSchema: jsonSchema<{
      url: string;
      selector?: string;
      extractLinks?: boolean;
    }>({
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "The URL to browse"
        },
        selector: {
          type: "string",
          description:
            "Optional CSS selector to focus extraction on a specific element (e.g. 'article', '.main-content')"
        },
        extractLinks: {
          type: "boolean",
          default: false,
          description: "Whether to extract links from the page"
        }
      },
      required: ["url"]
    }),
    execute: async ({ url, selector, extractLinks }) => {
      if (!ctx.browser) {
        return {
          error: "Browser automation is not available",
          code: "NO_BROWSER"
        };
      }
      const result = await ctx.browser.browse(url, {
        waitForNetworkIdle: true,
        selector,
        extractLinks,
        maxContentLength: 50000
      });

      if ("error" in result) {
        return { error: result.error, code: result.code };
      }

      return {
        url: result.url,
        title: result.title,
        content: result.content,
        links: result.links
      };
    }
  });
}

/**
 * Create the screenshot tool for capturing web pages
 */
export function createScreenshotTool(ctx: ToolContext) {
  return tool({
    description: `Take a screenshot of a web page. Returns a base64-encoded PNG image.

Use this to:
- Debug UI issues
- Document the visual state of a page
- Capture error messages or visual problems
- See what a web page looks like`,
    inputSchema: jsonSchema<{
      url: string;
      fullPage?: boolean;
      width?: number;
      height?: number;
    }>({
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "The URL to screenshot"
        },
        fullPage: {
          type: "boolean",
          default: false,
          description: "Capture the full scrollable page (not just viewport)"
        },
        width: {
          type: "number",
          default: 1280,
          description: "Viewport width in pixels"
        },
        height: {
          type: "number",
          default: 720,
          description: "Viewport height in pixels"
        }
      },
      required: ["url"]
    }),
    execute: async ({ url, fullPage, width, height }) => {
      if (!ctx.browser) {
        return {
          error: "Browser automation is not available",
          code: "NO_BROWSER"
        };
      }
      const result = await ctx.browser.screenshot(url, {
        fullPage,
        width,
        height,
        waitForNetworkIdle: true
      });

      if ("error" in result) {
        return { error: result.error, code: result.code };
      }

      return {
        url: result.url,
        title: result.title,
        imageBase64: result.imageBase64,
        mimeType: result.mimeType,
        dimensions: `${result.width}x${result.height}`
      };
    }
  });
}

/**
 * Create the interactWithPage tool for browser automation
 */
export function createInteractWithPageTool(ctx: ToolContext) {
  return tool({
    description: `Interact with a web page by performing actions like clicking, typing, etc.

Use this to:
- Test web applications
- Fill out and submit forms
- Navigate through multi-step flows
- Verify interactive features work

Actions are performed in sequence. If an action fails, subsequent actions still attempt to run.`,
    inputSchema: jsonSchema<{
      url: string;
      actions: Array<{
        type: "click" | "type" | "press" | "wait" | "scroll";
        selector?: string;
        text?: string;
        key?: string;
        ms?: number;
        direction?: "up" | "down";
      }>;
      screenshotAfter?: boolean;
    }>({
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "The starting URL"
        },
        actions: {
          type: "array",
          description: "Actions to perform in sequence",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["click", "type", "press", "wait", "scroll"],
                description:
                  "Action type: click (selector), type (selector + text), press (key), wait (ms), scroll (direction)"
              },
              selector: {
                type: "string",
                description: "CSS selector for click/type actions"
              },
              text: {
                type: "string",
                description: "Text to type (for type action)"
              },
              key: {
                type: "string",
                description: "Key to press (e.g. 'Enter', 'Tab', 'Escape')"
              },
              ms: {
                type: "number",
                description: "Milliseconds to wait (for wait action)"
              },
              direction: {
                type: "string",
                enum: ["up", "down"],
                description: "Scroll direction"
              }
            },
            required: ["type"]
          }
        },
        screenshotAfter: {
          type: "boolean",
          default: false,
          description: "Take a screenshot after all actions complete"
        }
      },
      required: ["url", "actions"]
    }),
    execute: async ({ url, actions, screenshotAfter }) => {
      if (!ctx.browser) {
        return {
          error: "Browser automation is not available",
          code: "NO_BROWSER"
        };
      }
      const result = await ctx.browser.interact(url, actions, {
        screenshotAfter,
        maxContentLength: 10000
      });

      if ("error" in result) {
        return { error: result.error, code: result.code };
      }

      return {
        url: result.url,
        title: result.title,
        actionsPerformed: result.actionsPerformed,
        content: result.content,
        screenshot: result.screenshot
      };
    }
  });
}

/**
 * Create the scrapePage tool for extracting specific elements
 */
export function createScrapePageTool(ctx: ToolContext) {
  return tool({
    description: `Scrape specific elements from a web page using CSS selectors.

Use this to:
- Extract structured data from pages
- Get lists of items (e.g. search results, product listings)
- Pull specific content by selector

Returns arrays of text content for each selector.`,
    inputSchema: jsonSchema<{
      url: string;
      selectors: Record<string, string>;
    }>({
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "The URL to scrape"
        },
        selectors: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Object mapping names to CSS selectors, e.g. { 'titles': 'h2.title', 'prices': '.price' }"
        }
      },
      required: ["url", "selectors"]
    }),
    execute: async ({ url, selectors }) => {
      if (!ctx.browser) {
        return {
          error: "Browser automation is not available",
          code: "NO_BROWSER"
        };
      }
      const result = await ctx.browser.scrape(url, selectors);

      if ("error" in result) {
        return { error: result.error, code: result.code };
      }

      return {
        url: result.url,
        title: result.title,
        data: result.data
      };
    }
  });
}

/**
 * Create all tools for the agent
 */
export function createTools(ctx: ToolContext) {
  return {
    bash: createBashTool(ctx),
    readFile: createReadFileTool(ctx),
    writeFile: createWriteFileTool(ctx),
    editFile: createEditFileTool(ctx),
    listFiles: createListFilesTool(ctx),
    fetch: createFetchTool(ctx),
    webSearch: createWebSearchTool(ctx),
    newsSearch: createNewsSearchTool(ctx),
    browseUrl: createBrowseUrlTool(ctx),
    screenshot: createScreenshotTool(ctx),
    interactWithPage: createInteractWithPageTool(ctx),
    scrapePage: createScrapePageTool(ctx)
  };
}

/**
 * System prompt for the coding agent
 */
export const SYSTEM_PROMPT = `You are a skilled coding assistant that helps users build and modify software projects.

You have access to tools that let you:
- Read and write files in the project
- Execute bash commands
- Fetch data from specific URLs (GitHub, npm, etc.)
- Search the web for documentation, tutorials, and current information
- Search for recent news and announcements
- Browse web pages and extract content (with full JavaScript rendering)
- Take screenshots of web pages
- Interact with web pages (click, type, navigate)
- Scrape specific elements from pages

## Guidelines

1. **Understand before acting**: When asked to make changes, first read the relevant files to understand the existing code structure.

2. **Make targeted edits**: Use editFile for small changes rather than rewriting entire files. This preserves formatting and reduces errors.

3. **Test your changes**: After making changes, run tests or verify the code works as expected when possible.

4. **Explain your work**: Briefly explain what you're doing and why, especially for non-trivial changes.

5. **Handle errors gracefully**: If a tool call fails, analyze the error and try a different approach.

6. **Be efficient**: Batch related operations when possible, but don't sacrifice clarity.

7. **Use web search wisely**: When you need to look up documentation, find examples, or research best practices, use the webSearch tool. Use newsSearch for recent announcements or updates.

8. **Use browser tools for dynamic content**: When you need to read content from JavaScript-heavy pages, test web apps, or interact with forms, use the browser tools (browseUrl, screenshot, interactWithPage, scrapePage).

## Code Style

- Write clean, readable code with appropriate comments
- Follow the existing style conventions in the project
- Use TypeScript when appropriate for new files
- Include error handling for edge cases

## Project Context

You're working in a cloud-native coding environment on Cloudflare Workers. The project uses:
- TypeScript
- Yjs for real-time collaboration and version control
- just-bash for shell command execution

Always be helpful, accurate, and thorough in your responses.`;
