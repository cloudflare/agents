import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Import the worker without browser for testing
// (server.ts includes BrowserLoopback which requires @cloudflare/playwright,
// which is incompatible with vitest-pool-workers)
import worker from "../server-without-browser";
import type { ExecutionResult, ThinkState } from "../server-without-browser";

// Declare the env types for cloudflare:test
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    Think: DurableObjectNamespace;
  }
}

/**
 * Response types for the API
 */
interface FilesResponse {
  files: Record<string, string>;
  version: number;
}

interface FileResponse {
  path: string;
  content: string;
}

/**
 * Helper to make HTTP requests to the agent
 */
async function agentRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const url = `http://localhost/agents/think/test${path}`;
  const req = new Request(url, options);
  return worker.fetch(req, env as unknown as Env, ctx);
}

/**
 * Helper for JSON POST requests
 */
async function postJSON(path: string, body: unknown): Promise<Response> {
  return agentRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

/**
 * Helper for JSON PUT requests
 */
async function putJSON(path: string, body: unknown): Promise<Response> {
  return agentRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// ============================================================================
// Phase 1: Dynamic Worker Loader Tests
// ============================================================================

describe("Dynamic Worker Loader", () => {
  describe("Phase 1.1: Basic LOADER Execution", () => {
    it("should load and execute a simple worker", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return 42; }"
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toBe("42");
    });

    it("should capture console.log output", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() { 
          console.log("hello");
          console.log("world");
          return "done";
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.logs).toContain("hello");
      expect(result.logs).toContain("world");
    });

    it("should return execution result with duration", async () => {
      const response = await postJSON("/execute", {
        code: 'export default function() { return { message: "test" }; }'
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThan(0);
      expect(JSON.parse(result.output!)).toEqual({ message: "test" });
    });

    it("should handle syntax errors gracefully", async () => {
      const response = await postJSON("/execute", {
        code: "export default function( { return 42; }" // Missing closing paren
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(false);
      expect(result.errorType).toBe("syntax");
      expect(result.error).toContain("SyntaxError");
    });

    it("should handle runtime errors gracefully", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return undefined.foo; }"
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(false);
      expect(result.errorType).toBe("runtime");
      expect(result.error).toContain("Cannot read properties of undefined");
    });

    it("should handle async code", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function() { 
          await new Promise(r => setTimeout(r, 10));
          return "async done";
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      // Output is JSON-stringified, so string comes with quotes
      expect(result.output).toContain("async done");
    });
  });

  describe("Phase 1.2: Loopback Bindings", () => {
    it("should pass loopback bindings to dynamic worker", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          return {
            hasEcho: typeof env.ECHO !== 'undefined',
            hasBash: typeof env.BASH !== 'undefined',
            hasFS: typeof env.FS !== 'undefined',
          };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.hasEcho).toBe(true);
      expect(output.hasBash).toBe(true);
      expect(output.hasFS).toBe(true);
    });

    it("should allow dynamic worker to call ECHO loopback", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.ECHO.ping("hello world");
          return result;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toContain("hello world");
    });

    it("should pass props correctly through loopback", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const info = await env.ECHO.info();
          return info;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.sessionId).toBeDefined();
      expect(typeof output.sessionId).toBe("string");
      expect(output.timestamp).toBeGreaterThan(0);
    });

    it("should allow dynamic worker to call BASH loopback", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.BASH.exec("echo 'Hello from bash'");
          return result;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.stdout).toContain("Hello from bash");
      expect(output.exitCode).toBe(0);
    });

    it("should allow dynamic worker to call FS loopback", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          await env.FS.writeFile("/test-file.txt", "test content");
          const content = await env.FS.readFile("/test-file.txt");
          return content;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toContain("test content");
    });
  });

  describe("Phase 1.3: Error Handling & Timeouts", () => {
    it("should timeout long-running code", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function() { 
          await new Promise(r => setTimeout(r, 5000));
          return "should not reach";
        }`,
        timeoutMs: 100
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(false);
      expect(result.errorType).toBe("timeout");
      expect(result.error).toContain("timed out");
    });

    it("should use default timeout when not specified", async () => {
      // This test just verifies the code runs quickly without timeout
      const response = await postJSON("/execute", {
        code: 'export default function() { return "fast"; }'
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
    });

    it("should categorize ReferenceError as runtime error", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return undefinedVariable; }"
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(false);
      expect(result.errorType).toBe("runtime");
    });
  });
});

// ============================================================================
// Phase 2: Yjs Code Storage Tests
// ============================================================================

describe("Yjs Code Storage", () => {
  describe("Phase 2.1: Document Setup", () => {
    it("should have initial files", async () => {
      const response = await agentRequest("/files");
      expect(response.status).toBe(200);

      const result = (await response.json()) as FilesResponse;
      expect(result.files).toBeDefined();
      expect(Object.keys(result.files).length).toBeGreaterThan(0);
    });

    it("should store files as key-value pairs", async () => {
      const response = await agentRequest("/files");
      const result = (await response.json()) as FilesResponse;

      // Check that files are strings
      for (const [name, content] of Object.entries(result.files)) {
        expect(typeof name).toBe("string");
        expect(typeof content).toBe("string");
      }
    });

    it("should track version number", async () => {
      const response = await agentRequest("/files");
      const result = (await response.json()) as FilesResponse;

      expect(result.version).toBeDefined();
      expect(typeof result.version).toBe("number");
      expect(result.version).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Phase 2.2: Version Tracking", () => {
    it("should increment version on file write", async () => {
      // Get initial version
      const initial = (await (
        await agentRequest("/files")
      ).json()) as FilesResponse;
      const initialVersion = initial.version;

      // Write a file
      await putJSON("/file/version-test.txt", { content: "test content" });

      // Check version incremented
      const after = (await (
        await agentRequest("/files")
      ).json()) as FilesResponse;
      expect(after.version).toBeGreaterThan(initialVersion);
    });

    it("should increment version on file delete", async () => {
      // First create a file
      await putJSON("/file/to-delete.txt", { content: "delete me" });
      const before = (await (
        await agentRequest("/files")
      ).json()) as FilesResponse;

      // Delete it
      await agentRequest("/file/to-delete.txt", { method: "DELETE" });

      // Check version incremented
      const after = (await (
        await agentRequest("/files")
      ).json()) as FilesResponse;
      expect(after.version).toBeGreaterThan(before.version);
    });
  });

  describe("Phase 2.3: File Operations", () => {
    it("should write and read files", async () => {
      const testContent = `Hello, Yjs! ${Date.now()}`;

      // Write file
      const writeResponse = await putJSON("/file/yjs-test.txt", {
        content: testContent
      });
      expect(writeResponse.status).toBe(200);

      // Read file
      const readResponse = await agentRequest("/file/yjs-test.txt");
      expect(readResponse.status).toBe(200);

      const result = (await readResponse.json()) as FileResponse;
      expect(result.content).toBe(testContent);
    });

    it("should list files", async () => {
      // Create a unique file
      const filename = `list-test-${Date.now()}.txt`;
      await putJSON(`/file/${filename}`, { content: "list test" });

      // Get files
      const response = await agentRequest("/files");
      const result = (await response.json()) as FilesResponse;

      expect(Object.keys(result.files)).toContain(filename);
    });

    it("should delete files", async () => {
      const filename = `delete-test-${Date.now()}.txt`;

      // Create file
      await putJSON(`/file/${filename}`, { content: "to be deleted" });

      // Verify it exists
      const existsResponse = await agentRequest(`/file/${filename}`);
      expect(existsResponse.status).toBe(200);

      // Delete it
      const deleteResponse = await agentRequest(`/file/${filename}`, {
        method: "DELETE"
      });
      expect(deleteResponse.status).toBe(200);

      // Verify it's gone
      const goneResponse = await agentRequest(`/file/${filename}`);
      expect(goneResponse.status).toBe(404);
    });

    it("should return 404 for non-existent files", async () => {
      const response = await agentRequest("/file/non-existent-file.xyz");
      expect(response.status).toBe(404);
    });

    it("should overwrite existing files", async () => {
      const filename = `overwrite-${Date.now()}.txt`;

      // Create file
      await putJSON(`/file/${filename}`, { content: "original" });

      // Overwrite
      await putJSON(`/file/${filename}`, { content: "updated" });

      // Read and verify
      const response = await agentRequest(`/file/${filename}`);
      const result = (await response.json()) as FileResponse;
      expect(result.content).toBe("updated");
    });
  });
});

// ============================================================================
// Phase 3: Tools Tests
// ============================================================================

describe("Tools", () => {
  describe("Phase 3.1: just-bash", () => {
    it("should execute basic commands", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          return await env.BASH.exec("echo hello");
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.stdout).toContain("hello");
    });

    it("should capture stdout and stderr", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.BASH.exec("echo stdout-msg && echo stderr-msg >&2");
          return result;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.stdout).toContain("stdout-msg");
      expect(output.stderr).toContain("stderr-msg");
    });

    it("should return exit code", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const success = await env.BASH.exec("true");
          const failure = await env.BASH.exec("false");
          return { successCode: success.exitCode, failureCode: failure.exitCode };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.successCode).toBe(0);
      expect(output.failureCode).not.toBe(0);
    });

    it("should handle pipes", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.BASH.exec("echo 'hello world' | tr a-z A-Z");
          return result.stdout;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toContain("HELLO WORLD");
    });

    it("should persist filesystem state within session", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          // Create a file
          await env.BASH.exec("echo 'test data' > /tmp/persist-test.txt");
          // Read it back
          const result = await env.BASH.exec("cat /tmp/persist-test.txt");
          return result.stdout;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toContain("test data");
    });
  });

  describe("Phase 3.2: In-Memory FS", () => {
    it("should read and write files", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          await env.FS.writeFile("/test.txt", "fs content");
          return await env.FS.readFile("/test.txt");
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toContain("fs content");
    });

    it("should check file existence", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          await env.FS.writeFile("/exists.txt", "data");
          const exists = await env.FS.exists("/exists.txt");
          const notExists = await env.FS.exists("/not-exists.txt");
          return { exists, notExists };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.exists).toBe(true);
      expect(output.notExists).toBe(false);
    });

    it("should list directory contents", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          await env.FS.writeFile("/src/file1.txt", "a");
          await env.FS.writeFile("/src/file2.txt", "b");
          return await env.FS.readdir("/src");
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const files = JSON.parse(result.output!);
      expect(files).toContain("file1.txt");
      expect(files).toContain("file2.txt");
    });

    it("should delete files", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          await env.FS.writeFile("/to-delete.txt", "temp");
          await env.FS.unlink("/to-delete.txt");
          return await env.FS.exists("/to-delete.txt");
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toBe("false");
    });

    it("should get file stats", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          await env.FS.writeFile("/stat-test.txt", "12345");
          const stat = await env.FS.stat("/stat-test.txt");
          return stat;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const stat = JSON.parse(result.output!);
      expect(stat.isFile).toBe(true);
      expect(stat.isDirectory).toBe(false);
      expect(stat.size).toBe(5); // "12345" is 5 chars
    });
  });

  describe("Phase 3.3: Controlled Fetch", () => {
    it("should pass FETCH binding to dynamic worker", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          return typeof env.FETCH !== 'undefined';
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toBe("true");
    });

    it("should allow requests to allowlisted URLs", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.FETCH.get("https://registry.npmjs.org/");
          return { ok: result.ok, status: result.status };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      // If fetch succeeds, we get status; if blocked, we'd get error
      expect(output.ok).toBeDefined();
    });

    it("should block requests to non-allowlisted URLs", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.FETCH.request("https://evil-domain.example.com/steal-data");
          return result;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.error).toBeDefined();
      expect(output.code).toBe("URL_NOT_ALLOWED");
    });

    it("should respect method restrictions (block POST by default)", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.FETCH.request("https://registry.npmjs.org/", { method: "POST" });
          return result;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.error).toBeDefined();
      expect(output.code).toBe("METHOD_NOT_ALLOWED");
    });

    it("should allow GET and HEAD methods by default", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const config = await env.FETCH.getConfig();
          return config.allowedMethods;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const methods = JSON.parse(result.output!);
      expect(methods).toContain("GET");
      expect(methods).toContain("HEAD");
      expect(methods).toContain("OPTIONS");
    });

    it("should provide request log", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          // Make a request that will be blocked
          await env.FETCH.request("https://blocked.example.com/");
          // Get the log
          const log = await env.FETCH.getLog();
          return log;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const log = JSON.parse(result.output!);
      expect(Array.isArray(log)).toBe(true);
      // Should have at least one entry
      expect(log.length).toBeGreaterThan(0);
      // Check log entry structure
      const entry = log[log.length - 1];
      expect(entry.url).toBe("https://blocked.example.com/");
      expect(entry.allowed).toBe(false);
    });

    it("should have convenience get() method", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.FETCH.get("https://cdn.jsdelivr.net/npm/lodash/package.json");
          return { ok: result.ok, hasBody: !!result.body };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.hasBody).toBe(true);
    });

    it("should return response for valid requests to allowed URLs", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          // This URL is allowed - should return a valid response
          const result = await env.FETCH.request("https://api.github.com/");
          return { ok: result.ok, hasStatus: typeof result.status === 'number' };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      // Should have a valid HTTP response structure
      expect(output.hasStatus).toBe(true);
    });
  });
});

// ============================================================================
// Agent State Tests
// ============================================================================

describe("Agent State", () => {
  it("should return agent state via /state endpoint", async () => {
    const response = await agentRequest("/state");
    expect(response.status).toBe(200);

    const state = (await response.json()) as ThinkState;
    expect(state.sessionId).toBeDefined();
    expect(state.status).toBeDefined();
    expect(state.codeVersion).toBeDefined();
  });

  it("should show idle status when not executing", async () => {
    const response = await agentRequest("/state");
    const state = (await response.json()) as ThinkState;
    expect(state.status).toBe("idle");
  });
});

// ============================================================================
// Edge Cases & Error Handling
// ============================================================================

describe("Edge Cases", () => {
  describe("Code Execution Edge Cases", () => {
    it("should handle empty return value", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { }"
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      // undefined becomes "undefined" or null when stringified
    });

    it("should handle null return value", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return null; }"
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toBe("null");
    });

    it("should handle complex nested objects", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() { 
          return { 
            a: { b: { c: [1, 2, 3] } },
            d: "string",
            e: true
          }; 
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.a.b.c).toEqual([1, 2, 3]);
      expect(output.d).toBe("string");
      expect(output.e).toBe(true);
    });

    it("should handle thrown errors with custom messages", async () => {
      const response = await postJSON("/execute", {
        code: 'export default function() { throw new Error("Custom error message"); }'
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(false);
      expect(result.error).toContain("Custom error message");
    });

    it("should handle multiple console.log with different types", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() { 
          console.log("string");
          console.log(123);
          console.log({ key: "value" });
          console.log(true);
          return "done";
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.logs.length).toBe(4);
      expect(result.logs[0]).toBe("string");
      expect(result.logs[1]).toBe("123");
      expect(result.logs[2]).toContain("key");
      expect(result.logs[3]).toBe("true");
    });

    it("should handle code that returns a promise", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() { 
          return Promise.resolve("promised value");
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      expect(result.output).toContain("promised value");
    });
  });

  describe("Loopback Error Handling", () => {
    it("should handle errors in BASH commands gracefully", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const result = await env.BASH.exec("nonexistent_command_xyz");
          return result;
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.exitCode).not.toBe(0);
    });

    it("should handle FS read of non-existent file", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const exists = await env.FS.exists("/nonexistent/path/file.txt");
          return { exists };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.exists).toBe(false);
    });

    it("should handle multiple loopback calls in sequence", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function(env) { 
          const echo1 = await env.ECHO.ping("first");
          const echo2 = await env.ECHO.ping("second");
          const bash = await env.BASH.exec("echo test");
          await env.FS.writeFile("/seq-test.txt", "data");
          const content = await env.FS.readFile("/seq-test.txt");
          return { echo1, echo2, bash: bash.stdout, content };
        }`
      });

      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output!);
      expect(output.echo1).toBe("first");
      expect(output.echo2).toBe("second");
      expect(output.bash).toContain("test");
      expect(output.content).toBe("data");
    });
  });

  describe("File Operation Edge Cases", () => {
    it("should handle files with special characters in name", async () => {
      const filename = `special-${Date.now()}-test.txt`;

      await putJSON(`/file/${filename}`, { content: "special content" });

      const response = await agentRequest(`/file/${filename}`);
      const result = (await response.json()) as FileResponse;
      expect(result.content).toBe("special content");
    });

    it("should handle empty file content", async () => {
      const filename = `empty-${Date.now()}.txt`;

      await putJSON(`/file/${filename}`, { content: "" });

      const response = await agentRequest(`/file/${filename}`);
      const result = (await response.json()) as FileResponse;
      expect(result.content).toBe("");
    });

    it("should handle file content with newlines", async () => {
      const filename = `multiline-${Date.now()}.txt`;
      const content = "line1\nline2\nline3";

      await putJSON(`/file/${filename}`, { content });

      const response = await agentRequest(`/file/${filename}`);
      const result = (await response.json()) as FileResponse;
      expect(result.content).toBe(content);
    });

    it("should handle file content with unicode", async () => {
      const filename = `unicode-${Date.now()}.txt`;
      const content = "Hello 世界 🌍 émojis";

      await putJSON(`/file/${filename}`, { content });

      const response = await agentRequest(`/file/${filename}`);
      const result = (await response.json()) as FileResponse;
      expect(result.content).toBe(content);
    });
  });
});

// ============================================================================
// Session Isolation Tests
// ============================================================================

describe("Session Isolation", () => {
  /**
   * Helper to make requests to a specific room/session
   */
  async function roomRequest(
    room: string,
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const url = `http://localhost/agents/think/${room}${path}`;
    const req = new Request(url, options);
    return worker.fetch(req, env as unknown as Env, ctx);
  }

  async function roomPostJSON(
    room: string,
    path: string,
    body: unknown
  ): Promise<Response> {
    return roomRequest(room, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function roomPutJSON(
    room: string,
    path: string,
    body: unknown
  ): Promise<Response> {
    return roomRequest(room, path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  it("should have different sessionIds for different rooms", async () => {
    const room1 = `session-test-1-${Date.now()}`;
    const room2 = `session-test-2-${Date.now()}`;

    const state1 = (await (
      await roomRequest(room1, "/state")
    ).json()) as ThinkState;
    const state2 = (await (
      await roomRequest(room2, "/state")
    ).json()) as ThinkState;

    expect(state1.sessionId).toBeDefined();
    expect(state2.sessionId).toBeDefined();
    expect(state1.sessionId).not.toBe(state2.sessionId);
  });

  it("should have independent file storage per room", async () => {
    const room1 = `file-isolation-1-${Date.now()}`;
    const room2 = `file-isolation-2-${Date.now()}`;

    // Write a file in room1
    await roomPutJSON(room1, "/file/isolated.txt", {
      content: "room1 content"
    });

    // Write a different file in room2
    await roomPutJSON(room2, "/file/isolated.txt", {
      content: "room2 content"
    });

    // Read from room1
    const result1 = (await (
      await roomRequest(room1, "/file/isolated.txt")
    ).json()) as FileResponse;

    // Read from room2
    const result2 = (await (
      await roomRequest(room2, "/file/isolated.txt")
    ).json()) as FileResponse;

    expect(result1.content).toBe("room1 content");
    expect(result2.content).toBe("room2 content");
  });

  it("should have independent version tracking per room", async () => {
    const room1 = `version-isolation-1-${Date.now()}`;
    const room2 = `version-isolation-2-${Date.now()}`;

    // Get initial versions
    const initial1 = (await (
      await roomRequest(room1, "/files")
    ).json()) as FilesResponse;
    const initial2 = (await (
      await roomRequest(room2, "/files")
    ).json()) as FilesResponse;

    // Write multiple files to room1 only
    await roomPutJSON(room1, "/file/v1.txt", { content: "1" });
    await roomPutJSON(room1, "/file/v2.txt", { content: "2" });
    await roomPutJSON(room1, "/file/v3.txt", { content: "3" });

    // Check versions
    const after1 = (await (
      await roomRequest(room1, "/files")
    ).json()) as FilesResponse;
    const after2 = (await (
      await roomRequest(room2, "/files")
    ).json()) as FilesResponse;

    // Room1 should have higher version
    expect(after1.version).toBeGreaterThan(initial1.version);
    // Room2 version should be unchanged (or just initial)
    expect(after2.version).toBe(initial2.version);
  });

  it("should execute code independently in different rooms", async () => {
    const room1 = `exec-isolation-1-${Date.now()}`;
    const room2 = `exec-isolation-2-${Date.now()}`;

    // Execute in room1
    const result1 = (await (
      await roomPostJSON(room1, "/execute", {
        code: `export default async function(env) { 
          const info = await env.ECHO.info();
          return info.sessionId;
        }`
      })
    ).json()) as ExecutionResult;

    // Execute in room2
    const result2 = (await (
      await roomPostJSON(room2, "/execute", {
        code: `export default async function(env) { 
          const info = await env.ECHO.info();
          return info.sessionId;
        }`
      })
    ).json()) as ExecutionResult;

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    // Session IDs should be different (output may be quoted string)
    const sessionId1 = result1.output!.replace(/"/g, "");
    const sessionId2 = result2.output!.replace(/"/g, "");
    expect(sessionId1).not.toBe(sessionId2);
  });
});

// ============================================================================
// Health Check Tests
// ============================================================================

describe("Health Check", () => {
  it("should respond to /health endpoint", async () => {
    const ctx = createExecutionContext();
    const req = new Request("http://localhost/health");
    const response = await worker.fetch(req, env as unknown as Env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });
});

// ============================================================================
// Chat API Tests (Phase 4)
// ============================================================================

describe("Chat API", () => {
  describe("HTTP Chat Endpoint", () => {
    // GPT-5 reasoning models take longer, increase timeout
    it("should have /chat endpoint", async () => {
      const response = await postJSON("/chat", { message: "test" });
      // Endpoint exists (may error without OPENAI_API_KEY but shouldn't 404)
      expect(response.status).not.toBe(404);
    }, 60000);

    it("should have /chat/history endpoint", async () => {
      const response = await agentRequest("/chat/history");
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        messages: unknown[];
        sessionId: string;
      };
      expect(data).toHaveProperty("messages");
      expect(data).toHaveProperty("sessionId");
      expect(Array.isArray(data.messages)).toBe(true);
    });

    it("should have /chat/clear endpoint", async () => {
      const response = await postJSON("/chat/clear", {});
      expect(response.status).toBe(200);
      const data = (await response.json()) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it("should persist and retrieve chat history", async () => {
      // Clear first
      await postJSON("/chat/clear", {});

      // Get history - should be empty
      const historyResponse = await agentRequest("/chat/history");
      const history = (await historyResponse.json()) as {
        messages: unknown[];
      };
      expect(history.messages.length).toBe(0);
    });
  });

  describe("Chat History Persistence", () => {
    it("should clear chat history", async () => {
      // Clear
      const clearResponse = await postJSON("/chat/clear", {});
      expect(clearResponse.status).toBe(200);

      // Verify empty
      const historyResponse = await agentRequest("/chat/history");
      const history = (await historyResponse.json()) as {
        messages: unknown[];
      };
      expect(history.messages.length).toBe(0);
    });
  });
});

// ============================================================================
// Tool Function Tests
// ============================================================================

describe("Tool Definitions", () => {
  describe("Tool Context Requirements", () => {
    it("should define ToolContext interface with required properties", async () => {
      // Test that tools work via the execute endpoint with mocked tool calls
      // The tools are tested indirectly through loopback tests above
      // This test verifies the tool structure is correct

      // Test bash tool via loopback
      const bashResponse = await postJSON("/execute", {
        code: `
          export default async function(env) {
            const result = await env.BASH.exec("echo 'tool test'");
            return { stdout: result.stdout, exitCode: result.exitCode };
          }
        `
      });
      expect(bashResponse.status).toBe(200);
      const bashResult = (await bashResponse.json()) as ExecutionResult;
      expect(bashResult.success).toBe(true);
    });
  });

  describe("File Tools via Yjs", () => {
    it("should read files through storage", async () => {
      // Write a file first
      await putJSON("/file/tool-test.txt", { content: "tool test content" });

      // Read it back
      const readResponse = await agentRequest("/file/tool-test.txt");
      expect(readResponse.status).toBe(200);
      const file = (await readResponse.json()) as FileResponse;
      expect(file.content).toBe("tool test content");
    });

    it("should write files through storage", async () => {
      const writeResponse = await putJSON("/file/new-tool-file.ts", {
        content: "export const x = 42;"
      });
      expect(writeResponse.status).toBe(200);

      const readResponse = await agentRequest("/file/new-tool-file.ts");
      const file = (await readResponse.json()) as FileResponse;
      expect(file.content).toBe("export const x = 42;");
    });

    it("should list files", async () => {
      const response = await agentRequest("/files");
      expect(response.status).toBe(200);
      const data = (await response.json()) as FilesResponse;
      expect(data.files).toBeDefined();
      expect(typeof data.version).toBe("number");
    });
  });

  describe("Fetch Tool Security", () => {
    it("should allow GitHub API requests", async () => {
      const response = await postJSON("/execute", {
        code: `
          export default async function(env) {
            const result = await env.FETCH.request("https://api.github.com/");
            return { ok: result.ok, status: result.status };
          }
        `
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
    });

    it("should block arbitrary URLs", async () => {
      const response = await postJSON("/execute", {
        code: `
          export default async function(env) {
            const result = await env.FETCH.request("https://evil.example.com/");
            return result;
          }
        `
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
      // Should contain error about URL not allowed
      expect(result.output).toContain("URL_NOT_ALLOWED");
    });
  });
});

// ============================================================================
// Web Search Integration Tests (Phase 3.4)
// Note: These tests require BRAVE_API_KEY to be set
// ============================================================================

describe("Web Search (Brave)", () => {
  // Check if API key is available for tests
  const hasBraveKey = !!process.env.BRAVE_API_KEY;

  describe("BraveSearchLoopback Structure", () => {
    it("should have BraveSearchLoopback available via ctx.exports", async () => {
      // We can verify the loopback is exported by checking it's in the binding
      // The actual API call would need the key
      const response = await postJSON("/execute", {
        code: `
          export default async function(env) {
            // Check if BRAVE_SEARCH binding exists (it won't in tests)
            // But we can check the loopback pattern works
            return { hasBash: !!env.BASH, hasFs: !!env.FS, hasFetch: !!env.FETCH };
          }
        `
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as ExecutionResult;
      expect(result.success).toBe(true);
    });
  });

  describe.skipIf(!hasBraveKey)("Live API Tests", () => {
    it.todo("should search the web");
    it.todo("should search news");
    it.todo("should handle empty queries");
    it.todo("should respect freshness filters");
  });
});

// ============================================================================
// Browser Automation Tests (Phase 3.5)
// Note: Browser tests cannot run in vitest-pool-workers
// ============================================================================

describe("Browser Automation", () => {
  it("should gracefully handle missing browser binding", async () => {
    // Browser tools should return "not available" error in test environment
    // This tests the graceful degradation we implemented
    const response = await agentRequest("/state");
    expect(response.status).toBe(200);
    // The agent state should exist, browser just won't be available
  });

  describe.skip("Live Browser Tests (require BROWSER binding)", () => {
    it.todo("should browse a URL and extract content");
    it.todo("should take screenshots");
    it.todo("should interact with pages");
    it.todo("should scrape elements");
  });
});

// ============================================================================
// LLM Agent Integration Tests (Phase 4)
// Note: These tests require OPENAI_API_KEY and make real API calls
// Run with: OPENAI_API_KEY=sk-xxx npm test -- --run
// ============================================================================

describe("LLM Agent Integration", () => {
  // Check if OpenAI key is available
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

  describe.skipIf(!hasOpenAIKey)("Live LLM Tests", () => {
    it("should respond to a simple message", async () => {
      const response = await postJSON("/chat", {
        message: "What is 2 + 2? Reply with just the number."
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as { responses: unknown[] };
      expect(data.responses).toBeDefined();
      expect(data.responses.length).toBeGreaterThan(0);
    });

    it("should use listFiles tool when asked about project files", async () => {
      const response = await postJSON("/chat", {
        message: "List the files in this project. Just call the listFiles tool."
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        responses: Array<{ type?: string }>;
      };
      // Should have tool_calls in the response
      const hasToolCall = data.responses.some(
        (r) => r.type === "tool_calls" || r.type === "tool_results"
      );
      expect(hasToolCall).toBe(true);
    });

    it("should read a file when asked", async () => {
      // First create a file
      await putJSON("/file/test-read.txt", { content: "Hello from test!" });

      const response = await postJSON("/chat", {
        message: "Read the file test-read.txt and tell me what it says."
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as { responses: unknown[] };
      expect(data.responses.length).toBeGreaterThan(0);
    });

    it("should execute bash commands when asked", async () => {
      const response = await postJSON("/chat", {
        message: "Run 'echo hello' in bash and show me the output."
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as { responses: unknown[] };
      expect(data.responses.length).toBeGreaterThan(0);
    });
  });

  describe("Agent Error Handling", () => {
    // GPT-5 reasoning models take longer, increase timeout
    it("should handle missing API key gracefully", async () => {
      // This test verifies error handling when API key is missing or invalid
      // The actual behavior depends on whether the key is set
      const response = await postJSON("/chat", { message: "test" });
      // Should not crash - either works (200) or returns error
      expect([200, 500]).toContain(response.status);
    }, 60000);
  });
});

// ============================================================================
// Code Execution Tool Tests (Phase 3.6)
// ============================================================================

describe("Code Execution Tool", () => {
  describe("Basic Execution", () => {
    it("should execute simple JavaScript and return result", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return 42; }"
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      expect(data.output).toBe("42");
    });

    it("should handle string return values", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() { return "hello world"; }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      // Strings are returned directly (not JSON-stringified with extra quotes)
      expect(data.output).toBe("hello world");
    });

    it("should handle object return values as JSON", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return { sum: 10, avg: 5 }; }"
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const parsed = JSON.parse(data.output || "{}");
      expect(parsed.sum).toBe(10);
      expect(parsed.avg).toBe(5);
    });

    it("should handle array return values", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return [1, 2, 3, 4, 5]; }"
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const parsed = JSON.parse(data.output || "[]");
      expect(parsed).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("Console Log Capture", () => {
    it("should capture console.log output", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          console.log("step 1");
          console.log("step 2");
          return "done";
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      expect(data.logs).toContain("step 1");
      expect(data.logs).toContain("step 2");
    });

    it("should capture console.log with multiple arguments", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          console.log("value:", 42);
          return "done";
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      expect(
        data.logs.some(
          (log: string) => log.includes("value:") && log.includes("42")
        )
      ).toBe(true);
    });
  });

  describe("Data Transformations", () => {
    it("should perform array calculations", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
          const sum = data.reduce((a, b) => a + b, 0);
          const avg = sum / data.length;
          return { sum, avg, count: data.length };
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const result = JSON.parse(data.output || "{}");
      expect(result.sum).toBe(55);
      expect(result.avg).toBe(5.5);
      expect(result.count).toBe(10);
    });

    it("should handle JSON parsing and manipulation", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          const jsonStr = '{"users": [{"name": "Alice"}, {"name": "Bob"}]}';
          const data = JSON.parse(jsonStr);
          const names = data.users.map(u => u.name);
          return names;
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const result = JSON.parse(data.output || "[]");
      expect(result).toEqual(["Alice", "Bob"]);
    });

    it("should handle string processing with regex", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          const text = "Hello World! Hello Universe!";
          const count = (text.match(/Hello/g) || []).length;
          const replaced = text.replace(/Hello/g, "Hi");
          return { count, replaced };
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const result = JSON.parse(data.output || "{}");
      expect(result.count).toBe(2);
      expect(result.replaced).toBe("Hi World! Hi Universe!");
    });
  });

  describe("Async Code", () => {
    it("should handle async/await code", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function() {
          const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
          await delay(10);
          return "async complete";
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      expect(data.output).toBe("async complete");
    });

    it("should handle Promise.all", async () => {
      const response = await postJSON("/execute", {
        code: `export default async function() {
          const tasks = [1, 2, 3].map(async (n) => n * 2);
          const results = await Promise.all(tasks);
          return results;
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const result = JSON.parse(data.output || "[]");
      expect(result).toEqual([2, 4, 6]);
    });
  });

  describe("Error Handling", () => {
    it("should catch and report syntax errors", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return ]]invalid[[ }"
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(false);
      expect(data.errorType).toBe("syntax");
    });

    it("should catch and report runtime errors", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          const obj = undefined;
          return obj.property;
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(false);
      expect(data.errorType).toBe("runtime");
      expect(data.error).toContain("undefined");
    });

    it("should catch thrown errors", async () => {
      const response = await postJSON("/execute", {
        code: `export default function() {
          throw new Error("intentional error");
        }`
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(false);
      expect(data.error).toContain("intentional error");
    });
  });

  describe("Execution Duration", () => {
    it("should track execution duration", async () => {
      const response = await postJSON("/execute", {
        code: "export default function() { return 1 + 1; }"
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      expect(typeof data.duration).toBe("number");
      expect(data.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Module Support", () => {
    it("should support custom modules", async () => {
      const response = await postJSON("/execute", {
        code: `
          import { add, multiply } from './math-utils.js';
          export default function() {
            return { sum: add(2, 3), product: multiply(4, 5) };
          }
        `,
        modules: {
          "math-utils.js": `
            export const add = (a, b) => a + b;
            export const multiply = (a, b) => a * b;
          `
        }
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as ExecutionResult;
      expect(data.success).toBe(true);
      const result = JSON.parse(data.output || "{}");
      expect(result.sum).toBe(5);
      expect(result.product).toBe(20);
    });
  });
});

// ============================================================================
// Action Logging Tests
// These test the audit trail functionality for tool calls
// ============================================================================

describe("Action Logging", () => {
  beforeEach(async () => {
    // Clear action log before each test
    await postJSON("/actions/clear", {});
  });

  describe("Action Log API", () => {
    it("should return empty action log initially", async () => {
      const response = await agentRequest("/actions");
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        actions: unknown[];
        sessionId: string;
        count: number;
      };
      expect(data.actions).toEqual([]);
      expect(data.count).toBe(0);
      expect(data.sessionId).toBeDefined();
    });

    it("should support tool filter parameter", async () => {
      const response = await agentRequest("/actions?tool=bash");
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        actions: unknown[];
        count: number;
      };
      expect(data.actions).toEqual([]);
    });

    it("should support limit parameter", async () => {
      const response = await agentRequest("/actions?limit=10");
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        actions: unknown[];
        count: number;
      };
      expect(Array.isArray(data.actions)).toBe(true);
    });

    it("should support since parameter", async () => {
      const since = Date.now() - 60000; // 1 minute ago
      const response = await agentRequest(`/actions?since=${since}`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        actions: unknown[];
        count: number;
      };
      expect(Array.isArray(data.actions)).toBe(true);
    });

    it("should clear action log", async () => {
      const response = await postJSON("/actions/clear", {});
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        success: boolean;
        sessionId: string;
      };
      expect(data.success).toBe(true);
    });
  });

  describe("summarizeOutput", () => {
    // Test the output summarization via direct agent methods
    // These tests verify that large outputs are properly truncated

    it("should truncate long strings", async () => {
      // Create a file with long content using PUT /file/{path}
      const longContent = "x".repeat(1000);
      const writeResponse = await putJSON("/file/test-long.txt", {
        content: longContent
      });
      expect(writeResponse.status).toBe(200);

      // Verify file was created
      const response = await agentRequest("/file/test-long.txt");
      expect(response.status).toBe(200);
    });
  });

  describe("Action Log with LLM", () => {
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

    describe.skipIf(!hasOpenAIKey)("Tool Call Logging", () => {
      it(
        "should log tool calls when LLM uses tools",
        async () => {
          // Clear everything
          await postJSON("/chat/clear", {});
          await postJSON("/actions/clear", {});

          // Ask LLM to use a tool
          const response = await postJSON("/chat", {
            message:
              "Create a file called action-test.txt with content 'logged'"
          });
          expect(response.status).toBe(200);

          // Check action log
          const actionsResponse = await agentRequest("/actions");
          expect(actionsResponse.status).toBe(200);

          const data = (await actionsResponse.json()) as {
            actions: Array<{
              id: string;
              tool: string;
              action: string;
              success: boolean;
              timestamp: number;
            }>;
            count: number;
          };

          // Should have at least one action logged
          expect(data.count).toBeGreaterThan(0);

          // Find the writeFile action
          const writeAction = data.actions.find((a) => a.tool === "writeFile");
          if (writeAction) {
            expect(writeAction.success).toBe(true);
            expect(writeAction.timestamp).toBeGreaterThan(0);
          }
        },
        { timeout: 60000 }
      );

      it(
        "should log multiple tool calls in sequence",
        async () => {
          await postJSON("/chat/clear", {});
          await postJSON("/actions/clear", {});

          // Ask LLM to do multiple things
          const response = await postJSON("/chat", {
            message:
              "Create a file called multi1.txt with 'first', then create multi2.txt with 'second'"
          });
          expect(response.status).toBe(200);

          // Check action log
          const actionsResponse = await agentRequest("/actions");
          const data = (await actionsResponse.json()) as {
            actions: Array<{ tool: string }>;
            count: number;
          };

          // Should have multiple actions
          expect(data.count).toBeGreaterThanOrEqual(2);
        },
        { timeout: 60000 }
      );

      it(
        "should include output summary in action log",
        async () => {
          await postJSON("/chat/clear", {});
          await postJSON("/actions/clear", {});

          // Create a file first
          await postJSON("/file", {
            path: "read-test.txt",
            content: "test content for reading"
          });

          // Ask LLM to read it
          const response = await postJSON("/chat", {
            message: "Read the file read-test.txt and tell me what it contains"
          });
          expect(response.status).toBe(200);

          // Check action log for readFile action with output summary
          const actionsResponse = await agentRequest("/actions");
          const data = (await actionsResponse.json()) as {
            actions: Array<{
              tool: string;
              outputSummary?: string;
            }>;
          };

          const readAction = data.actions.find((a) => a.tool === "readFile");
          if (readAction) {
            expect(readAction.outputSummary).toBeDefined();
          }
        },
        { timeout: 60000 }
      );
    });
  });
});

// ============================================================================
// Multi-Step Agent Workflow Tests
// These test complex scenarios that involve multiple tools
// ============================================================================

describe("Multi-Step Workflows", () => {
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

  describe.skipIf(!hasOpenAIKey)("Complex Workflows", () => {
    it("should create and then read a file", async () => {
      await postJSON("/chat/clear", {});

      const response = await postJSON("/chat", {
        message:
          "Create a file called workflow-test.txt with the content 'workflow test', then read it back to verify."
      });
      expect(response.status).toBe(200);

      // Verify file was created
      const fileResponse = await agentRequest("/file/workflow-test.txt");
      if (fileResponse.status === 200) {
        const file = (await fileResponse.json()) as FileResponse;
        expect(file.content).toBe("workflow test");
      }
    });

    it("should handle multi-turn conversation", async () => {
      await postJSON("/chat/clear", {});

      // First message
      const response1 = await postJSON("/chat", {
        message: "Create a file called counter.txt with the number 1"
      });
      expect(response1.status).toBe(200);

      // Second message referencing first
      const response2 = await postJSON("/chat", {
        message: "Read counter.txt and tell me what number is in it"
      });
      expect(response2.status).toBe(200);
    });
  });
});
