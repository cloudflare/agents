/**
 * Tests for curl verbose output (-v)
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
  return new Response('{"data":"test"}', {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "application/json",
      "x-custom-header": "test-value"
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

describe("curl verbose output", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe("-v/--verbose flag", () => {
    it("should show request line with -v", async () => {
      const env = createEnv();
      const result = await env.exec("curl -v https://api.example.com/test");
      expect(result.stdout).toContain("> GET");
      expect(result.stdout).toContain("/test");
    });

    it("should show response status line with -v", async () => {
      const env = createEnv();
      const result = await env.exec("curl -v https://api.example.com/test");
      expect(result.stdout).toContain("< HTTP/1.1 200");
    });

    it("should show response headers with -v", async () => {
      const env = createEnv();
      const result = await env.exec("curl -v https://api.example.com/test");
      expect(result.stdout).toContain("< content-type:");
    });

    it("should show request headers with -v", async () => {
      const env = createEnv();
      const result = await env.exec(
        'curl -v -H "Accept: application/json" https://api.example.com/test'
      );
      expect(result.stdout).toContain("> Accept: application/json");
    });

    it("--verbose should work same as -v", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl --verbose https://api.example.com/test"
      );
      expect(result.stdout).toContain("> GET");
      expect(result.stdout).toContain("< HTTP/1.1");
    });

    it("should include body after verbose headers", async () => {
      const env = createEnv();
      const result = await env.exec("curl -v https://api.example.com/test");
      expect(result.stdout).toContain('{"data":"test"}');
    });
  });

  describe("-i/--include flag", () => {
    it("should show response headers without request info", async () => {
      const env = createEnv();
      const result = await env.exec("curl -i https://api.example.com/test");
      expect(result.stdout).toContain("HTTP/1.1 200");
      expect(result.stdout).not.toContain("> GET"); // No request line
    });

    it("should show response body after headers", async () => {
      const env = createEnv();
      const result = await env.exec("curl -i https://api.example.com/test");
      expect(result.stdout).toContain("HTTP/1.1 200");
      expect(result.stdout).toContain('{"data":"test"}');
    });

    it("--include should work same as -i", async () => {
      const env = createEnv();
      const result = await env.exec(
        "curl --include https://api.example.com/test"
      );
      expect(result.stdout).toContain("HTTP/1.1 200");
    });
  });

  describe("HEAD request output", () => {
    it("should show only headers with -I", async () => {
      const env = createEnv();
      const result = await env.exec("curl -I https://api.example.com/test");
      expect(result.stdout).toContain("HTTP/1.1 200");
      // Body should not be included
    });

    it("-I with -v should show verbose headers", async () => {
      const env = createEnv();
      const result = await env.exec("curl -I -v https://api.example.com/test");
      expect(result.stdout).toContain("> HEAD");
      expect(result.stdout).toContain("< HTTP/1.1 200");
    });
  });

  describe("verbose with different HTTP methods", () => {
    it("should show POST method in verbose output", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      const result = await env.exec(
        'curl -v -X POST -d "test" https://api.example.com/test'
      );
      expect(result.stdout).toContain("> POST");
    });

    it("should show PUT method in verbose output", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      const result = await env.exec(
        'curl -v -X PUT -d "test" https://api.example.com/test'
      );
      expect(result.stdout).toContain("> PUT");
    });

    it("should show DELETE method in verbose output", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["DELETE"]
        }
      });
      const result = await env.exec(
        "curl -v -X DELETE https://api.example.com/test"
      );
      expect(result.stdout).toContain("> DELETE");
    });
  });

  describe("verbose with silent mode", () => {
    it("-sv should show verbose but suppress progress", async () => {
      const env = createEnv();
      const result = await env.exec("curl -sv https://api.example.com/test");
      // Verbose output should still be shown
      expect(result.stdout).toContain("< HTTP/1.1");
    });

    it("-s without -v should suppress all extra output", async () => {
      const env = createEnv();
      const result = await env.exec("curl -s https://api.example.com/test");
      expect(result.stdout).toBe('{"data":"test"}');
      expect(result.stdout).not.toContain("HTTP/1.1");
    });
  });
});
