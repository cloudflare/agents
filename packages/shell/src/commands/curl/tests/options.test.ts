/**
 * Tests for curl command-line options parsing and behavior
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

// All tests need network configured since curl doesn't exist otherwise
const createEnv = () =>
  new Bash({
    network: { allowedUrlPrefixes: ["https://api.example.com"] }
  });

describe("curl options", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastRequest = null;
  });

  describe("argument parsing", () => {
    it("requires URL", async () => {
      const env = createEnv();
      const result = await env.exec("curl");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("no URL specified");
    });

    it("rejects unknown long options", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl --unknown-option https://api.example.com"
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unrecognized option");
    });

    it("rejects unknown short options", async () => {
      const env = createEnv();
      const result = await env.exec("curl -z https://api.example.com");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid option");
    });
  });

  describe("HTTP methods", () => {
    it("uses GET by default", async () => {
      const env = createEnv();
      await env.exec("curl https://api.example.com/test");
      expect(lastRequest?.options.method).toBe("GET");
    });

    it("sets method with -X POST", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec("curl -X POST https://api.example.com/test");
      expect(lastRequest?.options.method).toBe("POST");
    });

    it("sets method with --request PUT", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      await env.exec("curl --request PUT https://api.example.com/test");
      expect(lastRequest?.options.method).toBe("PUT");
    });

    it("sets method with -XDELETE (no space)", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["DELETE"]
        }
      });
      await env.exec("curl -XDELETE https://api.example.com/test");
      expect(lastRequest?.options.method).toBe("DELETE");
    });
  });

  describe("headers", () => {
    it("sends header with -H", async () => {
      const env = createEnv();
      await env.exec(
        'curl -H "Authorization: Bearer token" https://api.example.com/test'
      );
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Authorization).toBe("Bearer token");
    });

    it("sends multiple headers", async () => {
      const env = createEnv();
      await env.exec(
        'curl -H "Accept: application/json" -H "X-Custom: value" https://api.example.com/test'
      );
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Accept).toBe("application/json");
      expect(headers?.["X-Custom"]).toBe("value");
    });

    it("sends header with --header=value format", async () => {
      const env = createEnv();
      await env.exec(
        'curl --header="X-Api-Key: secret123" https://api.example.com/test'
      );
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.["X-Api-Key"]).toBe("secret123");
    });

    it("sets User-Agent with -A", async () => {
      const env = createEnv();
      await env.exec('curl -A "MyApp/1.0" https://api.example.com/test');
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.["User-Agent"]).toBe("MyApp/1.0");
    });

    it("sets Referer with -e", async () => {
      const env = createEnv();
      await env.exec(
        'curl -e "https://referrer.com" https://api.example.com/test'
      );
      const headers = lastRequest?.options.headers as Record<string, string>;
      expect(headers?.Referer).toBe("https://referrer.com");
    });
  });

  describe("POST data", () => {
    it("sends data with -d and switches to POST", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec('curl -d "name=value" https://api.example.com/test');
      expect(lastRequest?.options.method).toBe("POST");
      expect(lastRequest?.options.body).toBe("name=value");
    });

    it("sends JSON with --data-raw", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        'curl --data-raw \'{"key": "value"}\' https://api.example.com/test'
      );
      expect(lastRequest?.options.body).toBe('{"key": "value"}');
    });

    it("sends data with --data=value format", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec('curl --data="foo=bar" https://api.example.com/test');
      expect(lastRequest?.options.body).toBe("foo=bar");
    });
  });

  describe("output options", () => {
    it("writes response to file with -o", async () => {
      const env = createEnv();
      await env.exec("curl -o /output.txt https://api.example.com/test");
      const content = await env.fs.readFile("/output.txt");
      expect(content).toBe('{"ok":true}');
    });

    it("writes to file named from URL with -O", async () => {
      const env = createEnv();
      const result = await env.exec("curl -O https://api.example.com/file.txt");
      expect(result.exitCode).toBe(0);
      // File is written to cwd (defaults to /home/user)
      const content = await env.fs.readFile("/home/user/file.txt");
      expect(content).toBe('{"ok":true}');
    });
  });

  describe("silent mode", () => {
    it("suppresses error output with -s", async () => {
      const env = createEnv();
      const result = await env.exec("curl -s https://other-domain.com/test");
      expect(result.stderr).toBe("");
    });

    it("shows errors with -sS", async () => {
      const env = createEnv();
      const result = await env.exec("curl -sS https://other-domain.com/test");
      expect(result.stderr).toContain("Network access denied");
    });
  });

  describe("combined options", () => {
    it("handles combined short options -sSf", async () => {
      const env = createEnv();
      const result = await env.exec("curl -sSf https://other-domain.com/test");
      expect(result.stderr).toContain("Network access denied");
      expect(result.exitCode).not.toBe(0);
    });

    it("handles -sSfL combined", async () => {
      const env = createEnv();
      await env.exec("curl -sSfL https://api.example.com/test");
      expect(lastRequest).not.toBeNull();
    });
  });

  describe("HEAD request", () => {
    it("uses HEAD method with -I", async () => {
      const env = createEnv();
      await env.exec("curl -I https://api.example.com/test");
      expect(lastRequest?.options.method).toBe("HEAD");
    });
  });

  describe("write-out format", () => {
    it("outputs http_code with -w", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -w "%{http_code}" https://api.example.com/test'
      );
      expect(result.stdout).toContain("200");
    });

    it("outputs newlines with \\n", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -w "\\n%{http_code}\\n" https://api.example.com/test'
      );
      expect(result.stdout).toContain("\n200\n");
    });
  });

  describe("URL normalization", () => {
    it("adds https:// if no protocol", async () => {
      const env = createEnv();
      await env.exec("curl api.example.com/test");
      expect(lastRequest?.url).toBe("https://api.example.com/test");
    });
  });
});
