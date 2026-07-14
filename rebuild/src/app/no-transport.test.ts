import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Acceptance test for audit 25's transport-removal wave: `src/app/` sources
 * (not tests — an adapter's own tests legitimately speak frames) must never
 * import `Connection`/`ConnectionRegistry`, hold a connection, or serialize a
 * wire frame. Everything transport lives under `src/adapters/`.
 */

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_FILES = ["agent.ts", "think.ts"];

const BANNED_SUBSTRINGS = ["cf_agent_", "JSON.stringify", "broadcast(", "conn.send"];

function read(file: string): string {
  return readFileSync(join(APP_DIR, file), "utf8");
}

describe("src/app/ acceptance: no transport (audit 25)", () => {
  for (const file of SOURCE_FILES) {
    describe(file, () => {
      const source = read(file);

      for (const banned of BANNED_SUBSTRINGS) {
        it(`contains no "${banned}"`, () => {
          expect(source).not.toContain(banned);
        });
      }

      it('imports neither "Connection" nor "ConnectionRegistry"', () => {
        const importLines = source
          .split("\n")
          .filter((line) => /^\s*import\b/.test(line));
        for (const line of importLines) {
          expect(line).not.toMatch(/\bConnection\b/);
          expect(line).not.toMatch(/\bConnectionRegistry\b/);
        }
      });

      it('mentions "frame" only inside comments, if at all', () => {
        const lines = source.split("\n");
        for (const line of lines) {
          if (!/frame/i.test(line)) continue;
          const trimmed = line.trim();
          const isComment = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/**");
          expect(isComment).toBe(true);
        }
      });
    });
  }
});
