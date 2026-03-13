/**
 * Tests for curl upload options
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
  return new Response('{"uploaded":true}', {
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

describe("curl upload", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    lastRequest = null;
  });

  describe("-T/--upload-file", () => {
    it("uploads file with -T and uses PUT method", async () => {
      const env = new Bash({
        files: { "/upload.txt": "upload content" },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      await env.exec(
        "curl -T /upload.txt https://api.example.com/files/upload.txt"
      );

      expect(lastRequest?.options.method).toBe("PUT");
      expect(lastRequest?.options.body).toBe("upload content");
    });

    it("uploads file with --upload-file", async () => {
      const env = new Bash({
        files: { "/data.bin": "binary data" },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      await env.exec(
        "curl --upload-file /data.bin https://api.example.com/files/data.bin"
      );

      expect(lastRequest?.options.method).toBe("PUT");
      expect(lastRequest?.options.body).toBe("binary data");
    });

    it("supports --upload-file=value format", async () => {
      const env = new Bash({
        files: { "/file.txt": "file data" },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      await env.exec(
        "curl --upload-file=/file.txt https://api.example.com/files/file.txt"
      );

      expect(lastRequest?.options.body).toBe("file data");
    });

    it("allows explicit method override with -X", async () => {
      const env = new Bash({
        files: { "/file.txt": "content" },
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["POST"]
        }
      });
      await env.exec(
        "curl -X POST -T /file.txt https://api.example.com/upload"
      );

      expect(lastRequest?.options.method).toBe("POST");
      expect(lastRequest?.options.body).toBe("content");
    });

    it("fails if file does not exist", async () => {
      const env = new Bash({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          allowedMethods: ["PUT"]
        }
      });
      const result = await env.exec(
        "curl -T /nonexistent.txt https://api.example.com/upload"
      );

      expect(result.exitCode).not.toBe(0);
    });
  });
});
