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
 */

import { tool, jsonSchema } from "ai";
import type { YjsStorage } from "./yjs-storage";
import type { BashLoopback } from "./loopbacks/bash";
import type { FetchLoopback } from "./loopbacks/fetch";

/**
 * Tool execution context passed from the Agent
 */
export interface ToolContext {
  storage: YjsStorage;
  bash: BashLoopback;
  fetch: FetchLoopback;
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
 * Create all tools for the agent
 */
export function createTools(ctx: ToolContext) {
  return {
    bash: createBashTool(ctx),
    readFile: createReadFileTool(ctx),
    writeFile: createWriteFileTool(ctx),
    editFile: createEditFileTool(ctx),
    listFiles: createListFilesTool(ctx),
    fetch: createFetchTool(ctx)
  };
}

/**
 * System prompt for the coding agent
 */
export const SYSTEM_PROMPT = `You are a skilled coding assistant that helps users build and modify software projects.

You have access to tools that let you:
- Read and write files in the project
- Execute bash commands
- Fetch data from the web

## Guidelines

1. **Understand before acting**: When asked to make changes, first read the relevant files to understand the existing code structure.

2. **Make targeted edits**: Use editFile for small changes rather than rewriting entire files. This preserves formatting and reduces errors.

3. **Test your changes**: After making changes, run tests or verify the code works as expected when possible.

4. **Explain your work**: Briefly explain what you're doing and why, especially for non-trivial changes.

5. **Handle errors gracefully**: If a tool call fails, analyze the error and try a different approach.

6. **Be efficient**: Batch related operations when possible, but don't sacrifice clarity.

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
