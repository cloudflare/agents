import { tool } from "ai";
import { z } from "zod";
import type { GrepOperations } from "./types";

const MAX_MATCHES = 200;

export interface GrepToolOptions {
  ops: GrepOperations;
}

export function createGrepTool(options: GrepToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "Search file contents using a regular expression or fixed string. " +
      "Returns matching lines with file paths and line numbers. " +
      "Searches all files matching the include glob, or all files if not specified.",
    inputSchema: z.object({
      query: z.string().describe("Search pattern (regex or fixed string)"),
      include: z
        .string()
        .optional()
        .describe(
          'Glob pattern to filter files (e.g. "**/*.ts"). Defaults to "**/*"'
        ),
      fixedString: z
        .boolean()
        .optional()
        .describe("If true, treat query as a literal string instead of regex"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("If true, search is case-sensitive (default: false)"),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Number of context lines around each match (default: 0)")
    }),
    execute: async ({
      query,
      include,
      fixedString,
      caseSensitive,
      contextLines
    }) => {
      const pattern = include ?? "**/*";
      const files = ops.glob(pattern).filter((f) => f.type === "file");

      let regex: RegExp;
      try {
        const escaped = fixedString ? escapeRegex(query) : query;
        regex = new RegExp(escaped, caseSensitive ? "g" : "gi");
      } catch {
        return { error: `Invalid regex: ${query}` };
      }

      const ctx = contextLines ?? 0;
      const matches: Array<{
        file: string;
        line: number;
        text: string;
        context?: string[];
      }> = [];
      let totalMatches = 0;
      let filesSearched = 0;
      let filesWithMatches = 0;

      for (const file of files) {
        if (totalMatches >= MAX_MATCHES) break;

        const content = await ops.readFile(file.path);
        if (content === null) continue;
        filesSearched++;

        const lines = content.split("\n");
        let fileHasMatch = false;

        for (let i = 0; i < lines.length; i++) {
          if (totalMatches >= MAX_MATCHES) break;

          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            if (!fileHasMatch) {
              fileHasMatch = true;
              filesWithMatches++;
            }
            totalMatches++;

            const match: {
              file: string;
              line: number;
              text: string;
              context?: string[];
            } = {
              file: file.path,
              line: i + 1,
              text: lines[i]
            };

            if (ctx > 0) {
              const start = Math.max(0, i - ctx);
              const end = Math.min(lines.length, i + ctx + 1);
              match.context = lines.slice(start, end).map((l, j) => {
                const lineNum = start + j + 1;
                const marker = lineNum === i + 1 ? ">" : " ";
                return `${marker} ${lineNum}\t${l}`;
              });
            }

            matches.push(match);
          }
        }
      }

      const result: Record<string, unknown> = {
        query,
        filesSearched,
        filesWithMatches,
        totalMatches,
        matches: matches.map((m) => {
          if (m.context) {
            return {
              file: m.file,
              line: m.line,
              context: m.context.join("\n")
            };
          }
          return `${m.file}:${m.line}: ${m.text}`;
        })
      };

      if (totalMatches >= MAX_MATCHES) {
        result.truncated = true;
      }

      return result;
    }
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
