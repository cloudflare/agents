import { describe, expect, it, vi } from "vitest";
import { Bash } from "../../Shell";
import type { MarkdownConverter } from "../../interfaces";

function createMockConverter(
  response: string | Error = "# Converted"
): MarkdownConverter {
  return {
    convert: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    })
  };
}

describe("html-to-markdown (interface-backed command)", () => {
  it("should not be available without a markdown converter", async () => {
    const env = new Bash();
    const result = await env.exec("html-to-markdown --help");
    // Command should not be registered
    expect(result.exitCode).not.toBe(0);
  });

  it("should be available when markdown converter is provided", async () => {
    const converter = createMockConverter();
    const env = new Bash({ markdown: converter });
    const result = await env.exec("html-to-markdown --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("html-to-markdown");
  });

  it("should convert HTML from stdin via pipe", async () => {
    const converter = createMockConverter("# Hello World");
    const env = new Bash({ markdown: converter });
    const result = await env.exec(
      'echo "<h1>Hello World</h1>" | html-to-markdown'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Hello World");
    expect(converter.convert).toHaveBeenCalled();
  });

  it("should convert HTML from a file argument", async () => {
    const converter = createMockConverter("# From File");
    const env = new Bash({
      markdown: converter,
      files: {
        "/test.html": "<h1>From File</h1>"
      }
    });
    const result = await env.exec("html-to-markdown /test.html");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# From File");
    expect(converter.convert).toHaveBeenCalledWith("<h1>From File</h1>");
  });

  it("should handle multiple file arguments", async () => {
    const converter = createMockConverter("# Combined");
    const env = new Bash({
      markdown: converter,
      files: {
        "/a.html": "<p>A</p>",
        "/b.html": "<p>B</p>"
      }
    });
    const result = await env.exec("html-to-markdown /a.html /b.html");
    expect(result.exitCode).toBe(0);
    // Both files should be concatenated and passed to converter
    const callArg = (converter.convert as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(callArg).toContain("<p>A</p>");
    expect(callArg).toContain("<p>B</p>");
  });

  it("should error on nonexistent file", async () => {
    const converter = createMockConverter();
    const env = new Bash({ markdown: converter });
    const result = await env.exec("html-to-markdown /nonexistent.html");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("html-to-markdown");
    expect(result.stderr).toContain("nonexistent.html");
  });

  it("should handle empty input", async () => {
    const converter = createMockConverter();
    const env = new Bash({ markdown: converter });
    const result = await env.exec('echo "" | html-to-markdown');
    expect(result.exitCode).toBe(0);
    // Empty input should not call converter
    expect(converter.convert).not.toHaveBeenCalled();
  });

  it("should handle converter errors gracefully", async () => {
    const converter = createMockConverter(new Error("API rate limited"));
    const env = new Bash({ markdown: converter });
    const result = await env.exec('echo "<h1>Test</h1>" | html-to-markdown');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("API rate limited");
  });

  it("should ensure output ends with newline", async () => {
    const converter = createMockConverter("no trailing newline");
    const env = new Bash({ markdown: converter });
    const result = await env.exec('echo "<p>test</p>" | html-to-markdown');
    expect(result.stdout).toMatch(/\n$/);
  });

  it("should not double newline if converter output already ends with one", async () => {
    const converter = createMockConverter("has trailing newline\n");
    const env = new Bash({ markdown: converter });
    const result = await env.exec('echo "<p>test</p>" | html-to-markdown');
    expect(result.stdout).toBe("has trailing newline\n");
  });
});
