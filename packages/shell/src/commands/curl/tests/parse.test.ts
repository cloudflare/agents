/**
 * Tests for curl option parsing edge cases
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
let lastRequest: { url: string; options: RequestInit } | null = null;

const mockFetch = vi.fn(async (url: string, options?: RequestInit) => {
  lastRequest = { url, options: options ?? {} };
  return new Response("OK", {
    status: 200,
    headers: { "content-type": "text/plain" }
  });
});

beforeAll(() => {
  global.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

const createEnv = () =>
  new Bash({
    network: {
      allowedUrlPrefixes: ["https://api.example.com"],
      allowedMethods: ["GET", "POST", "PUT", "DELETE"]
    }
  });

describe("curl option parsing", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastRequest = null;
  });

  describe("header parsing", () => {
    it("should parse header without colon", async () => {
      const env = createEnv();
      // Header without colon should be ignored or handled gracefully
      const result = await env.exec(
        'curl -H "NoColonHeader" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
    });

    it("should parse header with empty value", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -H "X-Empty:" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.["X-Empty"]).toBe("");
    });

    it("should parse header with spaces around colon", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -H "X-Test : value with spaces" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.["X-Test"]).toBe("value with spaces");
    });

    it("should parse header with multiple colons", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -H "X-Time: 12:30:45" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.["X-Time"]).toBe("12:30:45");
    });
  });

  describe("timeout parsing", () => {
    it("should parse integer timeout", async () => {
      const env = createEnv();
      const result = await env.exec("curl -m 30 https://api.example.com/test");
      expect(result.exitCode).toBe(0);
    });

    it("should parse decimal timeout", async () => {
      const env = createEnv();
      const result = await env.exec("curl -m 1.5 https://api.example.com/test");
      expect(result.exitCode).toBe(0);
    });

    it("should handle zero timeout gracefully", async () => {
      const env = createEnv();
      const result = await env.exec("curl -m 0 https://api.example.com/test");
      // Zero timeout should be ignored (no timeout set)
      expect(result.exitCode).toBe(0);
    });

    it("should handle negative timeout gracefully", async () => {
      const env = createEnv();
      const result = await env.exec("curl -m -5 https://api.example.com/test");
      // Negative timeout should be ignored
      expect(result.exitCode).toBe(0);
    });

    it("should handle non-numeric timeout", async () => {
      const env = createEnv();
      const result = await env.exec("curl -m abc https://api.example.com/test");
      // Invalid timeout should be ignored
      expect(result.exitCode).toBe(0);
    });

    it("should parse --max-time=value form", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl --max-time=10 https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should parse --connect-timeout", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl --connect-timeout=5 https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("data-urlencode parsing", () => {
    it("should URL-encode data with --data-urlencode", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s --data-urlencode "name=John Doe" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.options.body).toContain("John%20Doe");
    });

    it("should handle --data-urlencode=value form", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s --data-urlencode="foo=bar baz" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.options.body).toContain("bar%20baz");
    });

    it("should append multiple --data-urlencode values", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s --data-urlencode "a=1" --data-urlencode "b=2" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.options.body).toContain("&");
    });

    it("should encode special characters", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s --data-urlencode "q=hello&world" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      // & in value should be encoded
      expect(lastRequest?.options.body).toContain("%26");
    });
  });

  describe("combined short options", () => {
    it("should parse -sSf combined", async () => {
      const env = createEnv();
      const result = await env.exec("curl -sSf https://api.example.com/test");
      expect(result.exitCode).toBe(0);
    });

    it("should parse -sSfL combined", async () => {
      const env = createEnv();
      const result = await env.exec("curl -sSfL https://api.example.com/test");
      expect(result.exitCode).toBe(0);
    });

    it("should parse -sS combined", async () => {
      const env = createEnv();
      const result = await env.exec("curl -sS https://api.example.com/test");
      expect(result.exitCode).toBe(0);
    });

    it("should handle -s -o as separate options", async () => {
      const env = createEnv();
      // -o requires an argument, use separate options
      const result = await env.exec(
        "curl -s -o /output.txt https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("URL parsing", () => {
    it("should add https:// to URLs without protocol", async () => {
      const env = createEnv();
      const result = await env.exec("curl api.example.com/test");
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.url).toBe("https://api.example.com/test");
    });

    it("should preserve https:// in URLs", async () => {
      const env = createEnv();
      const result = await env.exec("curl https://api.example.com/test");
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.url).toBe("https://api.example.com/test");
    });

    it("should handle URL with query string", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl 'https://api.example.com/test?foo=bar&baz=qux'"
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.url).toContain("foo=bar");
    });

    it("should handle URL with fragment", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl 'https://api.example.com/test#section'"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("authentication parsing", () => {
    it("should parse -u user:pass", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl -u user:pass https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Authorization).toContain("Basic");
    });

    it("should parse -uuser:pass without space", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl -uuser:pass https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Authorization).toContain("Basic");
    });

    it("should parse --user=user:pass", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl --user=user:pass https://api.example.com/test"
      );
      expect(result.exitCode).toBe(0);
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Authorization).toContain("Basic");
    });
  });

  describe("data parsing variations", () => {
    it("should parse -d without space", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -d"test=value" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.options.body).toBe("test=value");
    });

    it("should parse --data=value", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl --data="test=value" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.options.body).toBe("test=value");
    });

    it("should parse --data-raw=value", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl --data-raw="@literal" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      // --data-raw treats @ literally
      expect(lastRequest?.options.body).toBe("@literal");
    });

    it("should parse --data-binary=value", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl --data-binary="binary data" https://api.example.com/test'
      );
      expect(result.exitCode).toBe(0);
      expect(lastRequest?.options.body).toBe("binary data");
    });
  });
});
