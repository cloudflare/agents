/**
 * Tests for curl cookie options
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
  return new Response('{"ok":true}', {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "session=abc123; Path=/; HttpOnly"
    }
  });
});

beforeAll(() => {
  global.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("curl cookies", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastRequest = null;
  });

  describe("-b/--cookie send cookies", () => {
    it("sends Cookie header with -b", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl -b 'session=xyz789' https://api.example.com/data");

      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Cookie).toBe("session=xyz789");
    });

    it("sends Cookie header with --cookie", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec(
        "curl --cookie 'auth=token123' https://api.example.com/data"
      );

      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Cookie).toBe("auth=token123");
    });

    it("supports --cookie=value format", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl --cookie=foo=bar https://api.example.com/data");

      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Cookie).toBe("foo=bar");
    });

    it("sends multiple cookies", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl -b 'a=1; b=2; c=3' https://api.example.com/data");

      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Cookie).toBe("a=1; b=2; c=3");
    });
  });

  describe("-c/--cookie-jar save cookies", () => {
    it("saves cookies to file with -c", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl -c /cookies.txt https://api.example.com/login");

      const cookies = await env.fs.readFile("/cookies.txt");
      expect(cookies).toContain("session=abc123");
    });

    it("saves cookies to file with --cookie-jar", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec(
        "curl --cookie-jar /jar.txt https://api.example.com/login"
      );

      const cookies = await env.fs.readFile("/jar.txt");
      expect(cookies).toContain("session=abc123");
    });

    it("supports --cookie-jar=value format", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec(
        "curl --cookie-jar=/save.txt https://api.example.com/login"
      );

      const cookies = await env.fs.readFile("/save.txt");
      expect(cookies).toContain("session=abc123");
    });
  });
});
