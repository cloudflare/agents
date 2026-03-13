/**
 * Tests for HTTP method restrictions in curl
 *
 * By default, only GET and HEAD methods are allowed.
 * Other methods require explicit allowedMethods config or dangerouslyAllowFullInternetAccess.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Bash } from "../../../Shell";

// Mock fetch for these tests
const originalFetch = global.fetch;
const mockFetch = vi.fn(async () => {
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

describe("curl HTTP method restrictions", () => {
  beforeAll(() => {
    mockFetch.mockClear();
  });

  describe("default allowed methods (GET, HEAD)", () => {
    it("allows GET requests by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com/data");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("not allowed");
    });

    it("allows HEAD requests by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -I https://api.example.com/data");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("not allowed");
    });

    it("blocks POST requests by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl -X POST https://api.example.com/data"
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("POST");
      expect(result.stderr).toContain("not allowed");
    });

    it("blocks PUT requests by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -X PUT https://api.example.com/data");
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("PUT");
      expect(result.stderr).toContain("not allowed");
    });

    it("blocks DELETE requests by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl -X DELETE https://api.example.com/data"
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("DELETE");
      expect(result.stderr).toContain("not allowed");
    });

    it("blocks PATCH requests by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl -X PATCH https://api.example.com/data"
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("PATCH");
      expect(result.stderr).toContain("not allowed");
    });

    it("blocks -d data (implies POST) by default", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        'curl -d "data=test" https://api.example.com/data'
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("POST");
      expect(result.stderr).toContain("not allowed");
    });
  });

  describe("custom allowed methods", () => {
    it("allows configured methods", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["GET", "POST"]
        }
      });
      const result = await env.exec(
        "curl -X POST https://api.example.com/data"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("not allowed");
    });

    it("blocks methods not in allowed list", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["GET", "POST"]
        }
      });
      const result = await env.exec(
        "curl -X DELETE https://api.example.com/data"
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("DELETE");
      expect(result.stderr).toContain("not allowed");
    });

    it("allows all specified methods", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"]
        }
      });

      const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
      for (const method of methods) {
        mockFetch.mockClear();
        const result = await env.exec(
          `curl -X ${method} https://api.example.com/data`
        );
        expect(result.stderr).not.toContain("not allowed");
      }
    });

    it("method check is case-insensitive", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["GET", "POST"]
        }
      });
      const result = await env.exec(
        "curl -X post https://api.example.com/data"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("dangerouslyAllowFullInternetAccess", () => {
    it("allows all methods with dangerous flag", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { dangerouslyAllowFullInternetAccess: true }
      });

      const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
      for (const method of methods) {
        mockFetch.mockClear();
        const result = await env.exec(
          `curl -X ${method} https://any-domain.com/data`
        );
        expect(result.stderr).not.toContain("not allowed");
      }
    });

    it("allows POST with data when dangerous flag is set", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { dangerouslyAllowFullInternetAccess: true }
      });
      const result = await env.exec(
        'curl -d "data=test" https://any-domain.com/data'
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error messages", () => {
    it("shows allowed methods in error message", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl -X POST https://api.example.com/data"
      );
      expect(result.stderr).toContain("GET");
      expect(result.stderr).toContain("HEAD");
    });

    it("silent mode hides method error", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl -s -X POST https://api.example.com/data"
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("");
    });

    it("-sS shows method error", async () => {
      mockFetch.mockClear();
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl -sS -X POST https://api.example.com/data"
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("not allowed");
    });
  });
});
