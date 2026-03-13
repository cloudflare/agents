/**
 * Tests for curl write-out format (-w)
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

const mockFetch = vi.fn(async (_url: string, _options?: RequestInit) => {
  return new Response('{"result":"success"}', {
    status: 201,
    statusText: "Created",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": "20"
    }
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
    network: { allowedUrlPrefixes: ["https://api.example.com"] }
  });

describe("curl write-out format", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe("%{http_code} format", () => {
    it("should output HTTP status code", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "%{http_code}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("201");
    });

    it("should output code after response body", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "%{http_code}" https://api.example.com/test'
      );
      expect(result.stdout).toBe('{"result":"success"}201');
    });

    it("should support code on new line", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "\\n%{http_code}" https://api.example.com/test'
      );
      expect(result.stdout).toBe('{"result":"success"}\n201');
    });
  });

  describe("%{content_type} format", () => {
    it("should output content type header", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "%{content_type}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("application/json; charset=utf-8");
    });
  });

  describe("%{url_effective} format", () => {
    it("should output the effective URL", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "%{url_effective}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("https://api.example.com/test");
    });
  });

  describe("%{size_download} format", () => {
    it("should output downloaded body size", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "%{size_download}" https://api.example.com/test'
      );
      // Body is '{"result":"success"}' = 20 chars
      expect(result.stdout).toContain("20");
    });
  });

  describe("combined format strings", () => {
    it("should support multiple format specifiers", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "code:%{http_code} type:%{content_type}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("code:201");
      expect(result.stdout).toContain("type:application/json; charset=utf-8");
    });

    it("should support newlines between format specifiers", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "\\ncode: %{http_code}\\ntype: %{content_type}\\n" https://api.example.com/test'
      );
      expect(result.stdout).toContain("\ncode: 201\n");
      expect(result.stdout).toContain("\ntype: application/json");
    });

    it("should handle literal text with format specifiers", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "HTTP %{http_code} OK" https://api.example.com/test'
      );
      expect(result.stdout).toContain("HTTP 201 OK");
    });
  });

  describe("--write-out option form", () => {
    it("should work with --write-out=value", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s --write-out="%{http_code}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("201");
    });
  });

  describe("write-out with other options", () => {
    it("should work with -o output file", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -o /output.json -w "%{http_code}" https://api.example.com/test'
      );
      // Write-out goes to stdout, body goes to file
      expect(result.stdout).toBe("201");
      const fileContent = await env.fs.readFile("/output.json");
      expect(fileContent).toBe('{"result":"success"}');
    });

    it("should work with -i include headers", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -i -w "\\nCODE:%{http_code}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("HTTP/1.1 201");
      expect(result.stdout).toContain("CODE:201");
    });
  });

  describe("invalid/unknown format specifiers", () => {
    it("should pass through unknown format specifiers", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -s -w "%{unknown_var}" https://api.example.com/test'
      );
      // Unknown variables should be passed through or empty
      expect(result.stdout).toContain('{"result":"success"}');
    });
  });
});
