import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
// The package subpath released packages load: the built entry point.
import * as chat from "agents/chat";
import { SQLITE_ROW_BYTES } from "../internal/platform-limits";

/**
 * Released packages whose peer range admits this `agents` import these
 * names from `agents/chat`; a missing one fails their module load.
 */
describe("agents/chat names released packages import", () => {
  it("still exports enforceRowSizeLimit (think 0.21-0.24, ai-chat 0.10-0.11) and sanitizeMessage (ai-chat 0.10-0.12)", () => {
    expect(typeof chat.enforceRowSizeLimit).toBe("function");
    expect(typeof chat.sanitizeMessage).toBe("function");
    const small: UIMessage = {
      id: "s",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    };
    expect(chat.enforceRowSizeLimit(small)).toBe(small);
    // think 0.24 and ai-chat 0.12 construct one.
    expect(typeof chat.TurnQueue).toBe("function");
    const big: UIMessage = {
      id: "b",
      role: "user",
      parts: [{ type: "text", text: "x".repeat(SQLITE_ROW_BYTES) }]
    };
    const cut = chat.enforceRowSizeLimit(big);
    expect(JSON.stringify(cut).length).toBeLessThan(SQLITE_ROW_BYTES);
  });
});

/**
 * Every name the released ai-chat and Think import from an `agents` entry
 * point, from their published dists (`released-imports.json`, read from the
 * npm tarballs). A name their JavaScript imports must be a runtime export of
 * the built entry, or they fail to load beside this `agents`; a name their
 * declarations import (values included) must be exported by the built
 * declarations, or they fail to type-check. Regenerate the list when a
 * release whose peer range admits this `agents` ships.
 */
describe("every name released ai-chat and Think import from agents", () => {
  const released = JSON.parse(
    readFileSync(resolve(__dirname, "released-imports.json"), "utf8")
  ) as Record<string, Record<string, { values: string[]; types: string[] }>>;
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    exports: Record<string, { types?: string; import?: string }>;
  };

  /** The names a built file exports (`export { … }` lists and declarations). */
  function exportedNames(file: string): Set<string> {
    const text = readFileSync(join(resolve("."), file), "utf8");
    const names = new Set<string>();
    for (const block of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
      for (const part of block[1].split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(" as ")
          .at(-1)
          ?.trim();
        if (name) names.add(name);
      }
    }
    for (const declared of text.matchAll(
      /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|namespace)\s+([A-Za-z0-9_$]+)/g
    )) {
      names.add(declared[1]);
    }
    return names;
  }

  for (const [release, entries] of Object.entries(released)) {
    it(`exports what ${release} imports`, () => {
      const missing: string[] = [];
      for (const [entry, { values, types }] of Object.entries(entries)) {
        const files =
          pkg.exports[
            entry === "agents" ? "." : `./${entry.slice("agents/".length)}`
          ];
        if (!files?.import || !files.types) {
          missing.push(`${entry} (no entry point)`);
          continue;
        }
        const runtime = exportedNames(files.import);
        const declared = exportedNames(files.types);
        for (const name of values) {
          if (!runtime.has(name)) missing.push(`${entry}: ${name} (runtime)`);
        }
        for (const name of types) {
          if (!declared.has(name)) missing.push(`${entry}: ${name} (type)`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
