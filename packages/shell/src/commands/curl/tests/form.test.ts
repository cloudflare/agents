/**
 * Tests for curl form data options
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
    headers: { "content-type": "application/json" }
  });
});

beforeAll(() => {
  global.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("curl form data", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastRequest = null;
  });

  describe("--data-urlencode", () => {
    it("URL-encodes data with --data-urlencode", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl --data-urlencode 'message=hello world' https://api.example.com/post"
      );

      expect(lastRequest?.options.body).toBe("message=hello%20world");
    });

    it("encodes special characters", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl --data-urlencode 'data=a&b=c' https://api.example.com/post"
      );

      expect(lastRequest?.options.body).toBe("data=a%26b%3Dc");
    });

    it("appends multiple --data-urlencode values", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl --data-urlencode 'a=1' --data-urlencode 'b=2' https://api.example.com/post"
      );

      expect(lastRequest?.options.body).toBe("a=1&b=2");
    });
  });

  describe("--data-binary", () => {
    it("sends data as-is with --data-binary", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        'curl --data-binary "line1\\nline2" https://api.example.com/post'
      );

      expect(lastRequest?.options.body).toBe("line1\\nline2");
    });

    it("supports --data-binary=value format", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec("curl --data-binary=rawdata https://api.example.com/post");

      expect(lastRequest?.options.body).toBe("rawdata");
    });
  });

  describe("-F/--form multipart", () => {
    it("sends multipart form data with -F", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec("curl -F 'name=John' https://api.example.com/upload");

      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.["Content-Type"]).toMatch(
        /^multipart\/form-data; boundary=/
      );
      expect(lastRequest?.options.body).toContain('name="name"');
      expect(lastRequest?.options.body).toContain("John");
    });

    it("sends multiple form fields", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl -F 'first=John' -F 'last=Doe' https://api.example.com/upload"
      );

      const body = lastRequest?.options.body as string;
      expect(body).toContain('name="first"');
      expect(body).toContain("John");
      expect(body).toContain('name="last"');
      expect(body).toContain("Doe");
    });

    it("uploads file content with @", async () => {
      const env = new Bash({
        files: { "/data.txt": "file contents here" },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl -F 'file=@/data.txt' https://api.example.com/upload"
      );

      const body = lastRequest?.options.body as string;
      expect(body).toContain('name="file"');
      expect(body).toContain('filename="data.txt"');
      expect(body).toContain("file contents here");
    });

    it("supports custom content type with ;type=", async () => {
      const env = new Bash({
        files: { "/doc.json": '{"key":"value"}' },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl -F 'data=@/doc.json;type=application/json' https://api.example.com/upload"
      );

      const body = lastRequest?.options.body as string;
      expect(body).toContain("Content-Type: application/json");
    });
  });
});
