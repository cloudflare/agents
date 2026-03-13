/**
 * Tests for curl timeout options
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { Bash } from "../../../Shell";

const originalFetch = global.fetch;
let lastSignal: AbortSignal | null | undefined;

const mockFetch = vi.fn(async (_url: string, options?: RequestInit) => {
  lastSignal = options?.signal;
  return new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" }
  });
});

beforeAll(() => {
  global.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("curl timeouts", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastSignal = undefined;
  });

  describe("-m/--max-time", () => {
    it("accepts -m timeout option", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -m 5 https://api.example.com/test");
      expect(result.exitCode).toBe(0);
      // Request was made with an abort signal
      expect(lastSignal).toBeDefined();
    });

    it("accepts --max-time timeout option", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl --max-time 10 https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });

    it("accepts --max-time=value format", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl --max-time=30 https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });

    it("accepts decimal timeout values", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -m 0.5 https://api.example.com/test");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("--connect-timeout", () => {
    it("accepts --connect-timeout option", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl --connect-timeout 5 https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });

    it("accepts --connect-timeout=value format", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl --connect-timeout=10 https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("timeout behavior", () => {
    it("reports timeout error on abort", async () => {
      // Create a mock that simulates abort
      const abortingFetch = vi.fn(
        async (_url: string, options?: RequestInit) => {
          if (options?.signal) {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            throw error;
          }
          return new Response('{"ok":true}', { status: 200 });
        }
      );
      global.fetch = abortingFetch as typeof fetch;

      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -m 1 https://api.example.com/slow");

      expect(result.exitCode).toBe(28); // CURLE_OPERATION_TIMEDOUT
      expect(result.stderr).toContain("aborted");

      // Restore mock
      global.fetch = mockFetch as typeof fetch;
    });
  });
});
