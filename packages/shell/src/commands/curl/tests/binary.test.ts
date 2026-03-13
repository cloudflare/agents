/**
 * Tests for curl binary data handling
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

beforeAll(() => {
  // Will be overridden in specific tests
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("curl binary data", () => {
  beforeEach(() => {
    lastRequest = null;
  });

  describe("binary response body", () => {
    it("handles binary response with null bytes", async () => {
      const binaryData = "data\0with\0nulls";
      global.fetch = vi.fn(async () => {
        return new Response(binaryData, {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        });
      }) as typeof fetch;

      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com/binary");

      expect(result.stdout).toBe(binaryData);
      expect(result.exitCode).toBe(0);
    });

    it("writes binary response to file with -o", async () => {
      const binaryData = "binary\0content\0here";
      global.fetch = vi.fn(async () => {
        return new Response(binaryData, {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        });
      }) as typeof fetch;

      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      await env.exec("curl -o /output.bin https://api.example.com/binary");

      const content = await env.fs.readFile("/output.bin");
      expect(content).toBe(binaryData);
    });

    it("handles binary response with high bytes", async () => {
      // Simulate high byte values (as they would appear in text)
      const binaryData = String.fromCharCode(0xff, 0xfe, 0x00, 0x01);
      global.fetch = vi.fn(async () => {
        return new Response(binaryData, {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        });
      }) as typeof fetch;

      const env = new Bash({
        network: { allowedUrlPrefixes: ["https://api.example.com"] }
      });
      const result = await env.exec("curl https://api.example.com/binary");

      expect(result.stdout).toBe(binaryData);
    });
  });

  describe("binary request body", () => {
    it("sends binary data with --data-binary", async () => {
      global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
        lastRequest = { url, options: options ?? {} };
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch;

      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        'curl --data-binary "line1\\nline2" https://api.example.com/upload'
      );

      // Note: shell escaping means \n is literal backslash-n, not newline
      expect(lastRequest?.options.body).toBe("line1\\nline2");
    });

    it("uploads binary file content with -T", async () => {
      global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
        lastRequest = { url, options: options ?? {} };
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch;

      const binaryContent = "binary\0file\0content";
      const env = new Bash({
        files: { "/data.bin": binaryContent },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      await env.exec("curl -T /data.bin https://api.example.com/upload");

      expect(lastRequest?.options.body).toBe(binaryContent);
    });

    it("uploads file with binary content in form field", async () => {
      global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
        lastRequest = { url, options: options ?? {} };
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch;

      const binaryContent = "file\0with\0binary";
      const env = new Bash({
        files: { "/upload.bin": binaryContent },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl -F 'file=@/upload.bin' https://api.example.com/upload"
      );

      const body = lastRequest?.options.body as string;
      expect(body).toContain(binaryContent);
    });
  });

  describe("binary files from virtual fs", () => {
    it("uploads Uint8Array file content", async () => {
      global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
        lastRequest = { url, options: options ?? {} };
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch;

      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([
            0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64
          ])
        },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      await env.exec("curl -T /binary.bin https://api.example.com/upload");

      expect(lastRequest?.options.body).toBe("Hello\0World");
    });
  });
});
