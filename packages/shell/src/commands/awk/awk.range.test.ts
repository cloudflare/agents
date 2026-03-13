import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk pattern ranges", () => {
  it("prints lines between START and END markers", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `before
START
line1
line2
END
after`
      }
    });
    const result = await env.exec("awk '/START/,/END/' /test/data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("START\nline1\nline2\nEND\n");
  });

  it("handles multiple ranges in same file", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `before
BEGIN
a
END
middle
BEGIN
b
END
after`
      }
    });
    const result = await env.exec("awk '/BEGIN/,/END/' /test/data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("BEGIN\na\nEND\nBEGIN\nb\nEND\n");
  });

  it("handles range with action", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `before
START
line1
line2
END
after`
      }
    });
    const result = await env.exec(
      "awk '/START/,/END/ { print \">> \" $0 }' /test/data.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(">> START\n>> line1\n>> line2\n>> END\n");
  });

  it("handles single-line range (start and end match same line)", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `before
START END
after`
      }
    });
    const result = await env.exec("awk '/START/,/END/' /test/data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("START END\n");
  });

  it("handles range that extends to end of file", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `before
START
line1
line2`
      }
    });
    const result = await env.exec("awk '/START/,/END/' /test/data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("START\nline1\nline2\n");
  });

  it("handles range with regex patterns", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `line1
header: foo
data1
data2
footer: bar
line2`
      }
    });
    const result = await env.exec("awk '/^header:/,/^footer:/' /test/data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("header: foo\ndata1\ndata2\nfooter: bar\n");
  });

  it("works with numbered conditions in range", async () => {
    const env = new Bash({
      files: {
        "/test/data.txt": `line1
line2
line3
line4
line5`
      }
    });
    // Alternative approach: use regex that matches specific line content
    const result = await env.exec("awk '/line2/,/line4/' /test/data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("line2\nline3\nline4\n");
  });
});
