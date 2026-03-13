/**
 * Tests for curl authentication options
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
  return new Response('{"authenticated":true}', {
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

describe("curl authentication", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastRequest = null;
  });

  describe("-u/--user basic auth", () => {
    it("sends Authorization header with -u user:pass", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl -u testuser:testpass https://api.example.com/auth");

      expect(lastRequest).not.toBeNull();
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Authorization).toMatch(/^Basic /);

      const encoded = headers.Authorization.replace("Basic ", "");
      const decoded = Buffer.from(encoded, "base64").toString();
      expect(decoded).toBe("testuser:testpass");
    });

    it("sends Authorization header with --user", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl --user admin:secret https://api.example.com/auth");

      const headers = lastRequest?.options.headers as Record<string, string>;
      const decoded = Buffer.from(
        headers.Authorization.replace("Basic ", ""),
        "base64"
      ).toString();
      expect(decoded).toBe("admin:secret");
    });

    it("supports --user=value format", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl --user=foo:bar https://api.example.com/auth");

      const headers = lastRequest?.options.headers as Record<string, string>;
      const decoded = Buffer.from(
        headers.Authorization.replace("Basic ", ""),
        "base64"
      ).toString();
      expect(decoded).toBe("foo:bar");
    });

    it("supports -uvalue format (no space)", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl -umyuser:mypass https://api.example.com/auth");

      const headers = lastRequest?.options.headers as Record<string, string>;
      const decoded = Buffer.from(
        headers.Authorization.replace("Basic ", ""),
        "base64"
      ).toString();
      expect(decoded).toBe("myuser:mypass");
    });

    it("handles special characters in password", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec('curl -u "user:p@ss:word!" https://api.example.com/auth');

      const headers = lastRequest?.options.headers as Record<string, string>;
      const decoded = Buffer.from(
        headers.Authorization.replace("Basic ", ""),
        "base64"
      ).toString();
      expect(decoded).toBe("user:p@ss:word!");
    });
  });
});
