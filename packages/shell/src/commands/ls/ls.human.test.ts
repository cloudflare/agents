import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("ls -h (human-readable)", () => {
  it("displays bytes for small files", async () => {
    const env = new Bash({
      files: {
        "/test/small.txt": { content: "a".repeat(100) }
      }
    });
    const result = await env.exec("ls -lh /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("100");
    expect(result.stdout).toContain("small.txt");
  });

  it("displays K for kilobyte-sized files", async () => {
    const env = new Bash({
      files: {
        "/test/medium.txt": { content: "a".repeat(1536) } // 1.5K
      }
    });
    const result = await env.exec("ls -lh /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/1\.5K/);
    expect(result.stdout).toContain("medium.txt");
  });

  it("displays rounded K for larger KB files", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": { content: "a".repeat(15 * 1024) } // 15K
      }
    });
    const result = await env.exec("ls -lh /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/15K/);
    expect(result.stdout).toContain("data.txt");
  });

  it("displays M for megabyte-sized files", async () => {
    const env = new Bash({
      files: {
        "/test/big.txt": { content: "a".repeat(2 * 1024 * 1024) } // 2M
      }
    });
    const result = await env.exec("ls -lh /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/2\.0M/);
    expect(result.stdout).toContain("big.txt");
  });

  it("works with --human-readable long form", async () => {
    const env = new Bash({
      files: {
        "/test/file.txt": { content: "a".repeat(2048) } // 2K
      }
    });
    const result = await env.exec("ls -l --human-readable /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/2\.0K/);
  });

  it("displays exact bytes without -h flag", async () => {
    const env = new Bash({
      files: {
        "/test/file.txt": { content: "a".repeat(1536) } // Would be 1.5K with -h
      }
    });
    const result = await env.exec("ls -l /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1536");
    expect(result.stdout).not.toMatch(/1\.5K/);
  });

  it("can combine -h with other flags", async () => {
    const env = new Bash({
      files: {
        "/test/visible.txt": { content: "a".repeat(3072) }, // 3K
        "/test/.hidden.txt": { content: "b".repeat(4096) } // 4K
      }
    });
    const result = await env.exec("ls -lah /test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/3\.0K/);
    expect(result.stdout).toMatch(/4\.0K/);
    expect(result.stdout).toContain(".hidden.txt");
  });
});
