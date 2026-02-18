/**
 * Unit tests for buildSystemPrompt and renderFileTree.
 * Pure Node.js — no Workers runtime or LLM calls needed.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, renderFileTree } from "../src/prompts";
import { DONE_TOOL_NAME } from "../src/tools";
import type { FileInfo } from "../src/workspace";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(
  name: string,
  size: number,
  type: "file" | "directory" = "file"
): FileInfo {
  const path = `/${name}`;
  return {
    path,
    name,
    type,
    mimeType: "text/plain",
    size,
    createdAt: 1_000_000,
    updatedAt: 1_000_000
  };
}

// ── renderFileTree ─────────────────────────────────────────────────────────────

describe("renderFileTree", () => {
  it("returns (empty) for an empty list", () => {
    expect(renderFileTree([])).toBe("(empty)");
  });

  it("renders a file with 📄 and byte size when < 1024 B", () => {
    const output = renderFileTree([makeFile("README.md", 512)]);
    expect(output).toContain("📄");
    expect(output).toContain("README.md");
    expect(output).toContain("512 B");
  });

  it("renders a file with KB size when ≥ 1024 B", () => {
    const output = renderFileTree([makeFile("bundle.js", 4096)]);
    expect(output).toContain("4 KB");
    expect(output).not.toContain("4096 B");
  });

  it("renders a directory with 📁 and no size", () => {
    const output = renderFileTree([makeFile("src", 0, "directory")]);
    expect(output).toContain("📁");
    expect(output).toContain("src");
    expect(output).not.toContain("KB");
    expect(output).not.toContain(" B");
  });

  it("renders multiple entries, one per line", () => {
    const output = renderFileTree([
      makeFile("src", 0, "directory"),
      makeFile("README.md", 256),
      makeFile("package.json", 800)
    ]);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("src");
    expect(lines[1]).toContain("README.md");
    expect(lines[2]).toContain("package.json");
  });

  it("boundary: exactly 1024 B renders as 1 KB", () => {
    const output = renderFileTree([makeFile("exact.txt", 1024)]);
    expect(output).toContain("1 KB");
  });

  it("boundary: 1023 B renders as B not KB", () => {
    const output = renderFileTree([makeFile("almost.txt", 1023)]);
    expect(output).toContain("1023 B");
    expect(output).not.toContain("KB");
  });
});

// ── buildSystemPrompt — structure ─────────────────────────────────────────────

describe("buildSystemPrompt — core sections", () => {
  it("always includes the agent identity preamble", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain("You are Think");
    expect(p).toContain("Cloudflare Worker");
  });

  it("always includes the Behaviour section", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain("## Behaviour");
    expect(p).toContain("Think step-by-step");
  });

  it("always includes the Workspace rules section", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain("## Workspace rules");
    expect(p).toContain("rooted at `/`");
  });

  it("references the done tool name in the behaviour rules", () => {
    const p = buildSystemPrompt(null);
    // The prompt tells the model to call `done` when finished
    expect(p).toContain(`\`${DONE_TOOL_NAME}\``);
  });

  it("warns not to call done prematurely", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain(`Do NOT call \`${DONE_TOOL_NAME}\` before`);
  });

  it("mentions bash cwd does not persist between calls", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain("cwd do NOT persist");
  });
});

// ── buildSystemPrompt — no workspace ─────────────────────────────────────────

describe("buildSystemPrompt — no workspace (null)", () => {
  it("includes a no-workspace mode section", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain("No workspace is attached");
  });

  it("tells the model it cannot read or write files", () => {
    const p = buildSystemPrompt(null);
    expect(p).toContain("cannot read or write files");
  });

  it("does NOT contain a file tree snippet", () => {
    const p = buildSystemPrompt(null);
    expect(p).not.toContain("📄");
    expect(p).not.toContain("📁");
  });
});

// ── buildSystemPrompt — empty workspace ───────────────────────────────────────

describe("buildSystemPrompt — empty workspace ([])", () => {
  it("includes a Workspace section", () => {
    const p = buildSystemPrompt([]);
    expect(p).toContain("## Workspace");
  });

  it("tells the model the workspace is empty", () => {
    const p = buildSystemPrompt([]);
    expect(p).toContain("workspace is empty");
    expect(p).toContain("Create any files");
  });

  it("does NOT contain a file tree snippet", () => {
    const p = buildSystemPrompt([]);
    expect(p).not.toContain("📄");
    expect(p).not.toContain("📁");
  });

  it("does NOT contain the no-workspace fallback message", () => {
    const p = buildSystemPrompt([]);
    expect(p).not.toContain("No workspace is attached");
  });
});

// ── buildSystemPrompt — populated workspace ───────────────────────────────────

describe("buildSystemPrompt — populated workspace", () => {
  const files: FileInfo[] = [
    makeFile("src", 0, "directory"),
    makeFile("README.md", 512),
    makeFile("package.json", 1200)
  ];

  it("includes a Workspace section with a code block", () => {
    const p = buildSystemPrompt(files);
    expect(p).toContain("## Workspace");
    expect(p).toContain("```");
  });

  it("renders the file tree inside the code block", () => {
    const p = buildSystemPrompt(files);
    expect(p).toContain("📁 src");
    expect(p).toContain("📄 README.md");
    expect(p).toContain("512 B");
    expect(p).toContain("📄 package.json");
    expect(p).toContain("1 KB");
  });

  it("prompts the model to use listFiles for subdirectories", () => {
    const p = buildSystemPrompt(files);
    expect(p).toContain("listFiles");
    expect(p).toContain("subdirectories");
  });

  it("does NOT contain the no-workspace or empty-workspace messages", () => {
    const p = buildSystemPrompt(files);
    expect(p).not.toContain("No workspace is attached");
    expect(p).not.toContain("workspace is empty");
  });
});

// ── buildSystemPrompt — output determinism ────────────────────────────────────

describe("buildSystemPrompt — determinism", () => {
  it("returns the same string for the same input (no randomness)", () => {
    const files: FileInfo[] = [makeFile("index.ts", 100)];
    expect(buildSystemPrompt(files)).toBe(buildSystemPrompt(files));
    expect(buildSystemPrompt(null)).toBe(buildSystemPrompt(null));
    expect(buildSystemPrompt([])).toBe(buildSystemPrompt([]));
  });
});
