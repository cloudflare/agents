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
import type {
  Task,
  TaskGraph,
  TaskType,
  TaskProgress,
  TaskTreeNode
} from "./tasks";

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
 * Result from executing JavaScript code
 */
export interface CodeExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  errorType?: "syntax" | "runtime" | "timeout" | "unknown";
  logs: string[];
  duration: number;
}

/**
 * Function to execute JavaScript code in a sandboxed environment
 */
export type ExecuteCodeFn = (
  code: string,
  options?: { modules?: Record<string, string>; timeoutMs?: number }
) => Promise<CodeExecutionResult>;

/**
 * Task management context for creating/managing subtasks
 */
export interface TaskContext {
  /** The current root task ID (created by orchestration for each user message) */
  currentTaskId: string;
  /** Get the current task graph */
  getTaskGraph(): TaskGraph;
  /** Create a subtask under the current task */
  createSubtask(input: {
    type: TaskType;
    title: string;
    description?: string;
    dependencies?: string[];
  }): Task | { error: string };
  /** Mark a task as complete */
  completeTask(taskId: string, result?: string): boolean;
  /** Get tasks ready to work on */
  getReadyTasks(): Task[];
  /** Get progress for the current task tree */
  getProgress(): TaskProgress;
  /** Get the task tree for display */
  getTaskTree(): TaskTreeNode[];
}

/**
 * Result from a subagent execution
 */
export interface SubagentResult {
  taskId: string;
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
}

/**
 * Context for subagent delegation
 */
export interface SubagentContext {
  /**
   * Delegate a task to a subagent for parallel execution.
   * The subagent runs as a facet with its own LLM context.
   */
  delegateTask(input: {
    taskId: string;
    title: string;
    description: string;
    context?: string;
  }): Promise<{ facetName: string } | { error: string }>;

  /**
   * Check if a delegated task is complete
   */
  getSubagentStatus(taskId: string): Promise<{
    status: "pending" | "running" | "complete" | "failed";
    result?: string;
    error?: string;
  } | null>;

  /**
   * Wait for all active subagents to complete
   */
  waitForSubagents(): Promise<SubagentResult[]>;

  /**
   * Get count of active subagents
   */
  activeCount(): number;
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
  /** Execute JavaScript code in a sandboxed environment */
  executeCode: ExecuteCodeFn;
  /** Task management - optional, only available when orchestration is enabled */
  tasks?: TaskContext;
  /** Subagent delegation - optional, for parallel task execution */
  subagents?: SubagentContext;
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
 * Create the executeCode tool for running JavaScript in a sandbox
 */
export function createExecuteCodeTool(ctx: ToolContext) {
  return tool({
    description: `Execute JavaScript code in a sandboxed environment. Use this for:
- Complex calculations and data transformations
- JSON parsing and manipulation
- String processing and formatting
- Algorithm implementation and testing
- Data analysis and aggregation
- Generating structured outputs

The code runs in an isolated V8 environment with:
- Full ES2024+ JavaScript support
- No network or filesystem access (use other tools for that)
- 30 second timeout by default
- console.log() outputs captured in logs

Return values are JSON-stringified. For complex outputs, return an object.

Example: "const data = [1,2,3,4,5]; const sum = data.reduce((a,b) => a+b, 0); return { sum, avg: sum/data.length };"`,
    inputSchema: jsonSchema<{
      code: string;
      modules?: Record<string, string>;
      timeoutMs?: number;
    }>({
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript code to execute. The code should use 'return' to provide a result. Use console.log() for intermediate outputs."
        },
        modules: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Optional ES modules to make available. Keys are import names, values are module code. Example: { 'utils': 'export const add = (a,b) => a+b;' }"
        },
        timeoutMs: {
          type: "number",
          description:
            "Maximum execution time in milliseconds (default: 30000, max: 120000)"
        }
      },
      required: ["code"]
    }),
    execute: async ({ code, modules, timeoutMs }) => {
      // Ensure timeout is within bounds
      const timeout = Math.min(Math.max(timeoutMs || 30000, 1000), 120000);

      const result = await ctx.executeCode(code, {
        modules,
        timeoutMs: timeout
      });

      if (result.success) {
        return {
          success: true,
          output: result.output,
          logs: result.logs,
          duration: result.duration
        };
      } else {
        return {
          success: false,
          error: result.error,
          errorType: result.errorType,
          logs: result.logs,
          duration: result.duration
        };
      }
    }
  });
}

/**
 * Create all tools for the agent
 */
// ============================================================================
// Task Management Tools
// ============================================================================

/**
 * Create the createSubtask tool for breaking down complex work
 */
export function createCreateSubtaskTool(ctx: ToolContext) {
  return tool({
    description: `Create a subtask to break down complex work into manageable pieces.

Use this when you're working on something substantial that has multiple distinct steps.
Each subtask can have dependencies on other subtasks - a task won't be "ready" until its dependencies are complete.

Examples:
- For "add authentication": create subtasks for research, backend, frontend, tests
- For "refactor database layer": create subtasks for each module to refactor
- For "fix bug X": create subtasks for reproduce, investigate, fix, verify

Subtasks help you stay organized and let the user see progress.`,
    inputSchema: jsonSchema<{
      type: "explore" | "code" | "test" | "review" | "plan" | "fix";
      title: string;
      description?: string;
      dependencies?: string[];
    }>({
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["explore", "code", "test", "review", "plan", "fix"],
          description:
            "Type of work: explore (research/investigate), code (implement), test (write tests), review (check work), plan (design approach), fix (bug fix)"
        },
        title: {
          type: "string",
          description: "Short, descriptive title for the subtask"
        },
        description: {
          type: "string",
          description: "Optional longer description of what needs to be done"
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional array of subtask IDs that must complete before this one can start"
        }
      },
      required: ["type", "title"]
    }),
    execute: async ({ type, title, description, dependencies }) => {
      if (!ctx.tasks) {
        return {
          error: "Task management not available",
          hint: "The orchestration layer handles task tracking automatically"
        };
      }

      const result = ctx.tasks.createSubtask({
        type,
        title,
        description,
        dependencies
      });

      if ("error" in result) {
        return { error: result.error };
      }

      return {
        id: result.id,
        title: result.title,
        type: result.type,
        status: result.status,
        message: `Created subtask: ${result.title}`
      };
    }
  });
}

/**
 * Create the listTasks tool for viewing current task state
 */
export function createListTasksTool(ctx: ToolContext) {
  return tool({
    description: `List all tasks and their current status.

Shows the task tree with:
- Task ID, title, type, and status
- Which tasks are ready to work on (all dependencies satisfied)
- Overall progress (percentage complete)

Use this to:
- See what work remains
- Check which tasks are blocked
- Review progress before reporting to user`,
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {}
    }),
    execute: async () => {
      if (!ctx.tasks) {
        return {
          tasks: [],
          progress: { total: 0, complete: 0, percentComplete: 0 },
          message:
            "Task management not available - working without task tracking"
        };
      }

      const tree = ctx.tasks.getTaskTree();
      const progress = ctx.tasks.getProgress();
      const ready = ctx.tasks.getReadyTasks();

      // Flatten tree for display
      const flattenTree = (
        nodes: TaskTreeNode[],
        result: Array<{
          id: string;
          title: string;
          type: string;
          status: string;
          depth: number;
          isReady: boolean;
        }> = []
      ) => {
        for (const node of nodes) {
          result.push({
            id: node.task.id,
            title: node.task.title,
            type: node.task.type,
            status: node.task.status,
            depth: node.depth,
            isReady: ready.some((t) => t.id === node.task.id)
          });
          flattenTree(node.children, result);
        }
        return result;
      };

      return {
        tasks: flattenTree(tree),
        progress: {
          total: progress.total,
          pending: progress.pending,
          inProgress: progress.inProgress,
          complete: progress.complete,
          blocked: progress.blocked,
          percentComplete: progress.percentComplete
        },
        readyCount: ready.length
      };
    }
  });
}

/**
 * Create the completeTask tool for marking work as done
 */
export function createCompleteTaskTool(ctx: ToolContext) {
  return tool({
    description: `Mark a subtask as complete.

Call this after you've finished the work for a subtask. This:
- Updates the task status to complete
- May unblock dependent tasks that were waiting
- Updates overall progress

You can optionally include a brief result/summary of what was accomplished.`,
    inputSchema: jsonSchema<{ taskId: string; result?: string }>({
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the subtask to mark complete"
        },
        result: {
          type: "string",
          description:
            "Optional brief summary of what was accomplished (e.g., 'Added JWT auth with refresh tokens')"
        }
      },
      required: ["taskId"]
    }),
    execute: async ({ taskId, result }) => {
      if (!ctx.tasks) {
        return {
          success: false,
          error: "Task management not available"
        };
      }

      const success = ctx.tasks.completeTask(taskId, result);

      if (!success) {
        return {
          success: false,
          error: `Could not complete task ${taskId} - task may not exist or already be complete`
        };
      }

      const progress = ctx.tasks.getProgress();
      const ready = ctx.tasks.getReadyTasks();

      return {
        success: true,
        message: `Task ${taskId} marked complete`,
        progress: {
          complete: progress.complete,
          total: progress.total,
          percentComplete: progress.percentComplete
        },
        nowReady: ready.map((t) => ({ id: t.id, title: t.title }))
      };
    }
  });
}

/**
 * Create the delegateToSubagent tool for parallel task execution
 */
export function createDelegateToSubagentTool(ctx: ToolContext) {
  return tool({
    description: `Delegate a task to a subagent for parallel execution.

Use this when you have a subtask that can be executed independently:
- The subagent runs in parallel with your main work
- It has its own focused LLM context
- Full tool access: read/write files, bash, fetch, web search (via RPC to parent)
- Good for: file operations, searches, refactoring, tests

Architecture: Subagents run in isolated environments but have full access to parent's tools via RPC. They receive task context via props and return results to the parent.

The parent updates task status when the subagent completes.
Check progress with checkSubagentStatus or wait for all with waitForSubagents.

IMPORTANT: Only delegate tasks that are truly independent - don't delegate tasks that depend on work you're still doing.`,
    inputSchema: jsonSchema<{
      taskId: string;
      title: string;
      description: string;
      context?: string;
    }>({
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "The ID of the subtask to delegate (must be a subtask you created)"
        },
        title: {
          type: "string",
          description: "Brief title for the subagent's work"
        },
        description: {
          type: "string",
          description:
            "Detailed description of what the subagent should do. Be specific!"
        },
        context: {
          type: "string",
          description:
            "Optional context to help the subagent (e.g., relevant file paths, constraints)"
        }
      },
      required: ["taskId", "title", "description"]
    }),
    execute: async ({ taskId, title, description, context }) => {
      if (!ctx.subagents) {
        return {
          success: false,
          error: "Subagent delegation not available"
        };
      }

      const result = await ctx.subagents.delegateTask({
        taskId,
        title,
        description,
        context
      });

      if ("error" in result) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        message: "Task delegated to subagent",
        facetName: result.facetName,
        taskId,
        activeSubagents: ctx.subagents.activeCount()
      };
    }
  });
}

/**
 * Create the checkSubagentStatus tool
 */
export function createCheckSubagentStatusTool(ctx: ToolContext) {
  return tool({
    description: `Check the status of a delegated subagent task.

Use this to see if a task you delegated is complete, still running, or failed.`,
    inputSchema: jsonSchema<{ taskId: string }>({
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The ID of the delegated task to check"
        }
      },
      required: ["taskId"]
    }),
    execute: async ({ taskId }) => {
      if (!ctx.subagents) {
        return { error: "Subagent delegation not available" };
      }

      const status = await ctx.subagents.getSubagentStatus(taskId);

      if (!status) {
        return {
          found: false,
          message: `No subagent found for task ${taskId}`
        };
      }

      return {
        found: true,
        taskId,
        status: status.status,
        result: status.result,
        error: status.error
      };
    }
  });
}

/**
 * Create the waitForSubagents tool
 */
export function createWaitForSubagentsTool(ctx: ToolContext) {
  return tool({
    description: `Wait for all active subagents to complete their work.

Use this when you need all delegated tasks to finish before proceeding.
Returns the results from all completed subagents.`,
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {}
    }),
    execute: async () => {
      if (!ctx.subagents) {
        return { error: "Subagent delegation not available" };
      }

      const results = await ctx.subagents.waitForSubagents();

      return {
        completed: results.length,
        results: results.map((r) => ({
          taskId: r.taskId,
          success: r.success,
          result: r.result?.slice(0, 200),
          error: r.error,
          durationMs: r.duration
        }))
      };
    }
  });
}

export function createTools(ctx: ToolContext) {
  // biome-ignore lint/suspicious/noExplicitAny: Tool types are complex and vary
  const tools: Record<string, any> = {
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
    scrapePage: createScrapePageTool(ctx),
    executeCode: createExecuteCodeTool(ctx)
  };

  // Add task management tools if task context is available
  if (ctx.tasks) {
    tools.createSubtask = createCreateSubtaskTool(ctx);
    tools.listTasks = createListTasksTool(ctx);
    tools.completeTask = createCompleteTaskTool(ctx);
  }

  // Add subagent delegation tools if subagent context is available
  if (ctx.subagents) {
    tools.delegateToSubagent = createDelegateToSubagentTool(ctx);
    tools.checkSubagentStatus = createCheckSubagentStatusTool(ctx);
    tools.waitForSubagents = createWaitForSubagentsTool(ctx);
  }

  return tools;
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
- Execute JavaScript code in a sandboxed environment for calculations, data transformations, and testing logic
- Create and manage subtasks for complex multi-step work (createSubtask, listTasks, completeTask)

## Guidelines

1. **Use markdown formatting**: Format your responses using markdown for clarity:
   - Use \`code\` for inline code, file names, and commands
   - Use code blocks with language tags for multi-line code
   - Use **bold** for emphasis and headers for structure
   - Use bullet points and numbered lists for steps
   - Use > blockquotes for important notes or warnings

2. **Understand before acting**: When asked to make changes, first read the relevant files to understand the existing code structure.

3. **Make targeted edits**: Use editFile for small changes rather than rewriting entire files. This preserves formatting and reduces errors.

4. **Test your changes**: After making changes, run tests or verify the code works as expected when possible.

5. **Explain your work**: Briefly explain what you're doing and why, especially for non-trivial changes.

6. **Handle errors gracefully**: If a tool call fails, analyze the error and try a different approach.

7. **Be efficient**: Batch related operations when possible, but don't sacrifice clarity.

8. **Use web search wisely**: When you need to look up documentation, find examples, or research best practices, use the webSearch tool. Use newsSearch for recent announcements or updates.

9. **Use browser tools for dynamic content**: When you need to read content from JavaScript-heavy pages, test web apps, or interact with forms, use the browser tools (browseUrl, screenshot, interactWithPage, scrapePage).

10. **Execute code for complex computations**: Use executeCode for data transformations, calculations, JSON manipulation, algorithm testing, and any logic that's easier to express in code than describe. This is safer than bash for pure computation.

## Task Management

For complex multi-step work, you have tools to break it down into tracked subtasks:

- **createSubtask**: Create a subtask with type (explore/code/test/review/plan/fix), title, and optional dependencies
- **listTasks**: View all tasks, their status, and overall progress
- **completeTask**: Mark a subtask as done with an optional result summary

**When to use task tools:**
- For substantial work with 3+ distinct steps (e.g., "add authentication", "refactor the API layer")
- When work has dependencies (frontend depends on backend being done first)
- When the user would benefit from seeing progress on a complex request

**When NOT to use task tools:**
- Simple, quick tasks (e.g., "fix this typo", "add a comment")
- Single-file changes
- When you can complete the whole request in one or two tool calls

**Guidelines:**
1. Create subtasks upfront when you recognize complex work
2. Use dependencies to model "B depends on A" relationships
3. Call completeTask after finishing each subtask to update progress
4. Use listTasks to check what's ready and report progress to the user
5. Focus on one task at a time - complete it fully before moving on

## Subagent Delegation (Parallel Work)

For truly independent subtasks, you can delegate work to subagents that run in parallel:

- **delegateToSubagent**: Assign a subtask to a subagent with its own focused LLM context
- **checkSubagentStatus**: Check if a delegated task is complete
- **waitForSubagents**: Wait for all delegated work to finish

**Subagent Capabilities:**
Subagents have full tool access via RPC to the parent:
- Read/write/delete files in the project (parent's Yjs storage)
- Execute bash commands
- Make HTTP requests (fetch)
- Perform web searches

**Architecture Note:** Subagents run in isolated environments (separate DO facets) but communicate with the parent via RPC. They receive task data via props and return results to the parent, which updates the task graph.

**When to delegate:**
- Independent file operations (e.g., "update config in file A" while you work on file B)
- Parallel searches or explorations
- Tests that can run concurrently
- Refactoring that doesn't affect files you're working on

**When NOT to delegate:**
- Tasks that depend on work you're still doing
- Tasks that need your current context/conversation
- Sequential work where order matters
- Very simple tasks (overhead isn't worth it)

**Guidelines:**
1. Only delegate after creating a subtask with createSubtask
2. Be specific in the description - the subagent has limited context
3. Use checkSubagentStatus or waitForSubagents to get results
4. The parent handles task status updates based on subagent results

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
