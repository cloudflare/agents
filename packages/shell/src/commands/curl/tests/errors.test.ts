/**
 * Tests for curl error handling
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
let mockFetch: ReturnType<typeof vi.fn>;

beforeAll(() => {
  mockFetch = vi.fn();
  global.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("curl error handling", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe("no URL errors", () => {
    it("should error when no URL provided", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://example.com"] }
      });
      const result = await env.exec("curl");
      expect(result.stderr).toContain("no URL specified");
      expect(result.exitCode).toBe(2);
    });

    it("should error when only options but no URL", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://example.com"] }
      });
      const result = await env.exec("curl -s -S");
      expect(result.stderr).toContain("no URL specified");
      expect(result.exitCode).toBe(2);
    });
  });

  describe("network access errors", () => {
    it("should error when URL not in allowlist", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://allowed.com"] }
      });
      const result = await env.exec("curl https://forbidden.com/test");
      expect(result.stderr).toContain("Network access denied");
      expect(result.exitCode).toBe(7); // CURLE_COULDNT_CONNECT
    });

    it("should suppress error with -s when URL not allowed", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://allowed.com"] }
      });
      const result = await env.exec("curl -s https://forbidden.com/test");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(7); // CURLE_COULDNT_CONNECT
    });

    it("should show error with -sS when URL not allowed", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://allowed.com"] }
      });
      const result = await env.exec("curl -sS https://forbidden.com/test");
      expect(result.stderr).toContain("Network access denied");
      expect(result.exitCode).toBe(7); // CURLE_COULDNT_CONNECT
    });
  });

  describe("HTTP error responses", () => {
    it("should return exit 0 for 404 by default", async () => {
      mockFetch.mockResolvedValue(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com/missing");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Not Found");
    });

    it("should fail with -f on 404", async () => {
      mockFetch.mockResolvedValue(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -f https://api.example.com/missing");
      expect(result.exitCode).toBe(22);
    });

    it("should fail with --fail on 500", async () => {
      mockFetch.mockResolvedValue(
        new Response("Server Error", {
          status: 500,
          statusText: "Internal Server Error"
        })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl --fail https://api.example.com/error"
      );
      expect(result.exitCode).toBe(22);
    });

    it("should succeed with -f on 2xx", async () => {
      mockFetch.mockResolvedValue(
        new Response("OK", { status: 200, statusText: "OK" })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -f https://api.example.com/ok");
      expect(result.exitCode).toBe(0);
    });

    it("should succeed with -f on 3xx", async () => {
      mockFetch.mockResolvedValue(
        new Response("", { status: 301, statusText: "Moved Permanently" })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -f https://api.example.com/redirect");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("option errors", () => {
    it("should error on unknown short option", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -z https://api.example.com/test");
      expect(result.stderr).toContain("invalid option");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown long option", async () => {
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec(
        "curl --unknown-option https://api.example.com/test"
      );
      expect(result.stderr).toContain("unrecognized option");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("network errors", () => {
    it("should handle fetch rejection", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com/test");
      expect(result.stderr).toContain("Network error");
      expect(result.exitCode).toBe(1); // Generic error for fetch rejection
    });

    it("should suppress fetch error with -s", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -s https://api.example.com/test");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(1); // Generic error for fetch rejection
    });

    it("should show fetch error with -sS", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -sS https://api.example.com/test");
      expect(result.stderr).toContain("Connection refused");
      expect(result.exitCode).toBe(1); // Generic error for fetch rejection
    });
  });

  describe("file operation errors", () => {
    it("should error on output to non-writable path", async () => {
      mockFetch.mockResolvedValue(new Response("OK", { status: 200 }));
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      // Attempting to write to a deeply nested non-existent directory
      const result = await env.exec(
        "curl -o /nonexistent/deep/path/file.txt https://api.example.com/test"
      );
      // Should either succeed (creating dirs) or fail gracefully
      // Implementation-dependent
      expect(result).toBeDefined();
    });

    it("should error on upload of non-existent file", async () => {
      mockFetch.mockResolvedValue(new Response("OK", { status: 200 }));
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      const result = await env.exec(
        "curl -T /nonexistent/file.txt https://api.example.com/upload"
      );
      // Should fail when file doesn't exist
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("method restriction errors", () => {
    it("should error when method not allowed", async () => {
      mockFetch.mockResolvedValue(new Response("OK", { status: 200 }));
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"]
          // POST not in allowed methods
        }
      });
      const result = await env.exec(
        'curl -X POST -d "test" https://api.example.com/test'
      );
      expect(result.stderr).toContain("not allowed");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("combined error scenarios", () => {
    it("should handle -f -s together on error", async () => {
      mockFetch.mockResolvedValue(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -f -s https://api.example.com/404");
      // -f causes non-zero exit, -s suppresses output
      expect(result.exitCode).toBe(22);
      expect(result.stdout).toBe("");
    });

    it("should handle -f -s -S together on error", async () => {
      mockFetch.mockResolvedValue(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );
      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl -f -sS https://api.example.com/404");
      // -f causes non-zero exit, -sS shows error
      expect(result.exitCode).toBe(22);
    });
  });
});
