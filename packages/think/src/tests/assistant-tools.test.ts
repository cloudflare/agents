import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

async function freshAgent(name: string) {
  return getAgentByName(env.TestAssistantToolsAgent, name);
}

function asciiBytes(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ── Read tool ─────────────────────────────────────────────────────────

describe("assistant tools — read", () => {
  it("reads a file with line numbers", async () => {
    const agent = await freshAgent("read-basic");
    await agent.seed([{ path: "/hello.txt", content: "line1\nline2\nline3" }]);
    const result = (await agent.toolRead("/hello.txt")) as {
      path: string;
      content: string;
      totalLines: number;
    };
    expect(result.path).toBe("/hello.txt");
    expect(result.totalLines).toBe(3);
    expect(result.content).toContain("1\tline1");
    expect(result.content).toContain("2\tline2");
    expect(result.content).toContain("3\tline3");
  });

  it("returns error for missing file", async () => {
    const agent = await freshAgent("read-missing");
    const result = (await agent.toolRead("/nope.txt")) as { error: string };
    expect(result.error).toContain("File not found");
  });

  it("returns error for directory", async () => {
    const agent = await freshAgent("read-dir");
    await agent.seedDir("/mydir");
    const result = (await agent.toolRead("/mydir")) as { error: string };
    expect(result.error).toContain("directory");
  });

  it("supports offset and limit", async () => {
    const agent = await freshAgent("read-offset");
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join(
      "\n"
    );
    await agent.seed([{ path: "/big.txt", content: lines }]);
    const result = (await agent.toolRead("/big.txt", 3, 2)) as {
      content: string;
      fromLine: number;
      toLine: number;
    };
    expect(result.fromLine).toBe(3);
    expect(result.toLine).toBe(4);
    expect(result.content).toContain("3\tline3");
    expect(result.content).toContain("4\tline4");
    expect(result.content).not.toContain("2\tline2");
    expect(result.content).not.toContain("5\tline5");
  });

  it("returns compact image metadata and model image content", async () => {
    const agent = await freshAgent("read-image-mime");
    await agent.seedBytes("/screenshot", PNG_BYTES, "image/png");

    const result = (await agent.toolRead("/screenshot")) as {
      kind: string;
      path: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      data?: string;
      content?: string;
    };
    expect(result).toMatchObject({
      kind: "image",
      path: "/screenshot",
      name: "screenshot",
      mediaType: "image/png",
      sizeBytes: PNG_BYTES.length
    });
    expect(result.data).toBeUndefined();
    expect(result.content).toBeUndefined();

    const modelOutput = (await agent.toolReadModelOutput("/screenshot")) as {
      type: string;
      value: Array<{ type: string; data?: string; mediaType?: string }>;
    };
    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value).toContainEqual({
      type: "image-data",
      data: "iVBORw0KGgo=",
      mediaType: "image/png"
    });
  });

  it.each([
    ["png", PNG_BYTES, "image/png"],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["gif", asciiBytes("GIF89a"), "image/gif"],
    [
      "webp",
      [...asciiBytes("RIFF"), 0x00, 0x00, 0x00, 0x00, ...asciiBytes("WEBP")],
      "image/webp"
    ]
  ])(
    "sniffs %s image bytes when MIME is generic",
    async (name, bytes, mediaType) => {
      const agent = await freshAgent(`read-image-sniff-${name}`);
      await agent.seedBytes("/generic.bin", bytes, "application/octet-stream");

      const result = (await agent.toolRead("/generic.bin")) as {
        kind: string;
        mediaType: string;
      };
      expect(result.kind).toBe("image");
      expect(result.mediaType).toBe(mediaType);
    }
  );

  it("returns file-data model output for PDFs", async () => {
    const agent = await freshAgent("read-pdf");
    const pdfBytes = asciiBytes("%PDF-1.4\n");
    await agent.seedBytes("/doc", pdfBytes, "application/octet-stream");

    const result = (await agent.toolRead("/doc")) as {
      kind: string;
      mediaType: string;
      data?: string;
    };
    expect(result.kind).toBe("file");
    expect(result.mediaType).toBe("application/pdf");
    expect(result.data).toBeUndefined();

    const modelOutput = (await agent.toolReadModelOutput("/doc")) as {
      type: string;
      value: Array<{
        type: string;
        data?: string;
        mediaType?: string;
        filename?: string;
      }>;
    };
    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value).toContainEqual({
      type: "file-data",
      data: "JVBERi0xLjQK",
      mediaType: "application/pdf",
      filename: "doc"
    });
  });

  it("does not line-number unknown binary files", async () => {
    const agent = await freshAgent("read-unknown-binary");
    await agent.seedBytes(
      "/blob.bin",
      [0x00, 0x9f, 0x92, 0x96],
      "application/octet-stream"
    );

    const result = (await agent.toolRead("/blob.bin")) as {
      kind: string;
      unsupported: boolean;
      content?: string;
      mediaType: string;
    };
    expect(result.kind).toBe("binary");
    expect(result.unsupported).toBe(true);
    expect(result.mediaType).toBe("application/octet-stream");
    expect(result.content).toBeUndefined();
  });
});

// ── Write tool ────────────────────────────────────────────────────────

describe("assistant tools — write", () => {
  it("writes a file and reports stats", async () => {
    const agent = await freshAgent("write-basic");
    const result = (await agent.toolWrite("/out.txt", "hello world")) as {
      path: string;
      bytesWritten: number;
      lines: number;
    };
    expect(result.path).toBe("/out.txt");
    expect(result.bytesWritten).toBe(11);
    expect(result.lines).toBe(1);

    // Verify via read
    const readResult = (await agent.toolRead("/out.txt")) as {
      content: string;
    };
    expect(readResult.content).toContain("hello world");
  });

  it("creates parent directories", async () => {
    const agent = await freshAgent("write-mkdir");
    await agent.toolWrite("/a/b/c/deep.txt", "deep");
    const result = (await agent.toolRead("/a/b/c/deep.txt")) as {
      content: string;
    };
    expect(result.content).toContain("deep");
  });
});

// ── Edit tool ─────────────────────────────────────────────────────────

describe("assistant tools — edit", () => {
  it("replaces exact match", async () => {
    const agent = await freshAgent("edit-exact");
    await agent.seed([{ path: "/f.txt", content: "hello world" }]);
    const result = (await agent.toolEdit("/f.txt", "hello", "goodbye")) as {
      replaced: boolean;
    };
    expect(result.replaced).toBe(true);

    const read = (await agent.toolRead("/f.txt")) as { content: string };
    expect(read.content).toContain("goodbye world");
  });

  it("returns error for missing file", async () => {
    const agent = await freshAgent("edit-missing");
    const result = (await agent.toolEdit("/nope.txt", "a", "b")) as {
      error: string;
    };
    expect(result.error).toContain("File not found");
  });

  it("returns error when old_string not found", async () => {
    const agent = await freshAgent("edit-not-found");
    await agent.seed([{ path: "/f.txt", content: "hello" }]);
    const result = (await agent.toolEdit("/f.txt", "xyz", "abc")) as {
      error: string;
    };
    expect(result.error).toContain("not found");
  });

  it("returns error when old_string has multiple matches", async () => {
    const agent = await freshAgent("edit-multiple");
    await agent.seed([{ path: "/f.txt", content: "aa bb aa" }]);
    const result = (await agent.toolEdit("/f.txt", "aa", "cc")) as {
      error: string;
    };
    expect(result.error).toContain("2 times");
  });

  it("creates new file with empty old_string", async () => {
    const agent = await freshAgent("edit-create");
    const result = (await agent.toolEdit("/new.txt", "", "new content")) as {
      created: boolean;
    };
    expect(result.created).toBe(true);

    const read = (await agent.toolRead("/new.txt")) as { content: string };
    expect(read.content).toContain("new content");
  });

  it("fuzzy matches on whitespace differences", async () => {
    const agent = await freshAgent("edit-fuzzy");
    await agent.seed([{ path: "/f.txt", content: "hello   world" }]);
    const result = (await agent.toolEdit(
      "/f.txt",
      "hello world",
      "goodbye world"
    )) as { replaced: boolean; fuzzyMatch: boolean };
    expect(result.replaced).toBe(true);
    expect(result.fuzzyMatch).toBe(true);

    const read = (await agent.toolRead("/f.txt")) as { content: string };
    expect(read.content).toContain("goodbye world");
  });

  it("returns error for ambiguous fuzzy match", async () => {
    const agent = await freshAgent("edit-fuzzy-ambiguous");
    // Two regions that differ only in whitespace, both matching "hello world"
    await agent.seed([
      {
        path: "/f.txt",
        content: "hello   world\nsome other text\nhello\tworld"
      }
    ]);
    const result = (await agent.toolEdit(
      "/f.txt",
      "hello world",
      "goodbye world"
    )) as { error: string };
    expect(result.error).toContain("multiple locations");
  });
});

// ── List tool ─────────────────────────────────────────────────────────

describe("assistant tools — list", () => {
  it("lists files and directories", async () => {
    const agent = await freshAgent("list-basic");
    await agent.seed([
      { path: "/readme.md", content: "# Hello" },
      { path: "/src/index.ts", content: "export {}" }
    ]);
    const result = (await agent.toolList("/")) as {
      count: number;
      entries: string[];
    };
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.entries.some((e: string) => e.includes("readme.md"))).toBe(
      true
    );
    expect(result.entries.some((e: string) => e.includes("src/"))).toBe(true);
  });
});

// ── Find tool ─────────────────────────────────────────────────────────

describe("assistant tools — find", () => {
  it("finds files by glob pattern", async () => {
    const agent = await freshAgent("find-basic");
    await agent.seed([
      { path: "/src/a.ts", content: "a" },
      { path: "/src/b.ts", content: "b" },
      { path: "/src/c.js", content: "c" },
      { path: "/readme.md", content: "# Hi" }
    ]);
    const result = (await agent.toolFind("/src/**/*.ts")) as {
      count: number;
      files: string[];
    };
    expect(result.count).toBe(2);
    expect(result.files).toContain("/src/a.ts");
    expect(result.files).toContain("/src/b.ts");
  });
});

// ── Grep tool ─────────────────────────────────────────────────────────

describe("assistant tools — grep", () => {
  it("searches file contents with regex", async () => {
    const agent = await freshAgent("grep-regex");
    await agent.seed([
      { path: "/a.ts", content: "const foo = 1;\nconst bar = 2;" },
      { path: "/b.ts", content: "let baz = 3;" }
    ]);
    const result = (await agent.toolGrep("const", "/**.ts")) as {
      totalMatches: number;
      filesWithMatches: number;
    };
    expect(result.totalMatches).toBe(2);
    expect(result.filesWithMatches).toBe(1);
  });

  it("searches with fixed string", async () => {
    const agent = await freshAgent("grep-fixed");
    await agent.seed([
      { path: "/a.txt", content: "hello (world)" },
      { path: "/b.txt", content: "no match" }
    ]);
    const result = (await agent.toolGrep("(world)", "/**.txt", true)) as {
      totalMatches: number;
    };
    expect(result.totalMatches).toBe(1);
  });

  it("supports case-sensitive search", async () => {
    const agent = await freshAgent("grep-case");
    await agent.seed([{ path: "/a.txt", content: "Hello\nhello\nHELLO" }]);
    const insensitive = (await agent.toolGrep(
      "hello",
      "/**.txt",
      true,
      false
    )) as { totalMatches: number };
    expect(insensitive.totalMatches).toBe(3);

    const sensitive = (await agent.toolGrep(
      "hello",
      "/**.txt",
      true,
      true
    )) as { totalMatches: number };
    expect(sensitive.totalMatches).toBe(1);
  });

  it("returns context lines when requested", async () => {
    const agent = await freshAgent("grep-context");
    await agent.seed([
      { path: "/a.txt", content: "line1\nline2\nMATCH\nline4\nline5" }
    ]);
    const result = (await agent.toolGrep(
      "MATCH",
      "/**.txt",
      true,
      true,
      1
    )) as { matches: Array<{ context: string }> };
    expect(result.matches.length).toBe(1);
    const ctx = result.matches[0].context;
    expect(ctx).toContain("line2");
    expect(ctx).toContain("MATCH");
    expect(ctx).toContain("line4");
  });

  it("skips files larger than 1 MB", async () => {
    const agent = await freshAgent("grep-large-skip");
    // Seed a small file with a match and a large file (>1MB) with the same match
    await agent.seed([{ path: "/small.txt", content: "FINDME here" }]);
    await agent.seedLargeFile("/large.txt", 1_100_000); // ~1.1 MB

    const result = (await agent.toolGrep("FINDME", "/**.*")) as {
      totalMatches: number;
      filesSkipped: number;
      note: string;
    };
    expect(result.totalMatches).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.note).toContain("skipped");
  });
});
