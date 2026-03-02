import { tool } from "ai";
import { z } from "zod";
import type { EditOperations } from "./types";

export interface EditToolOptions {
  ops: EditOperations;
}

export function createEditTool(options: EditToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "Make a targeted edit to a file by replacing an exact string match. " +
      "Provide the old_string to find and new_string to replace it with. " +
      "The old_string must match exactly (including whitespace and indentation). " +
      "Use an empty old_string with new_string to create a new file.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      old_string: z
        .string()
        .describe(
          "Exact text to find and replace. Empty string to create a new file."
        ),
      new_string: z.string().describe("Replacement text")
    }),
    execute: async ({ path, old_string, new_string }) => {
      // Create new file
      if (old_string === "") {
        const existing = await ops.readFile(path);
        if (existing !== null) {
          return {
            error:
              "File already exists. Provide old_string to edit, or use the write tool to overwrite."
          };
        }
        await ops.writeFile(path, new_string);
        return {
          path,
          created: true,
          lines: new_string.split("\n").length
        };
      }

      // Edit existing file
      const content = await ops.readFile(path);
      if (content === null) {
        return { error: `File not found: ${path}` };
      }

      // Count occurrences
      const occurrences = countOccurrences(content, old_string);
      if (occurrences === 0) {
        // Try fuzzy match — normalize whitespace and look again
        const fuzzyResult = fuzzyReplace(content, old_string, new_string);
        if (fuzzyResult !== null) {
          await ops.writeFile(path, fuzzyResult);
          return {
            path,
            replaced: true,
            fuzzyMatch: true,
            lines: fuzzyResult.split("\n").length
          };
        }

        return {
          error:
            "old_string not found in file. Make sure it matches exactly, " +
            "including whitespace and indentation. Read the file first to verify."
        };
      }

      if (occurrences > 1) {
        return {
          error:
            `old_string appears ${occurrences} times in the file. ` +
            "Include more surrounding context to make the match unique."
        };
      }

      const newContent = content.replace(old_string, new_string);
      await ops.writeFile(path, newContent);

      return {
        path,
        replaced: true,
        lines: newContent.split("\n").length
      };
    }
  });
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) break;
    count++;
    pos = idx + 1;
  }
  return count;
}

/**
 * Fuzzy replacement: normalize whitespace in both the file content
 * and the search string, find the match, then replace the corresponding
 * region in the original content.
 */
function fuzzyReplace(
  content: string,
  oldStr: string,
  newStr: string
): string | null {
  const normalizedContent = normalizeWhitespace(content);
  const normalizedSearch = normalizeWhitespace(oldStr);

  if (!normalizedSearch) return null;

  const idx = normalizedContent.indexOf(normalizedSearch);
  if (idx === -1) return null;

  // Map the normalized index back to the original content.
  // Walk both strings in parallel to find the original start/end.
  const originalStart = mapToOriginal(content, normalizedContent, idx);
  const originalEnd = mapToOriginal(
    content,
    normalizedContent,
    idx + normalizedSearch.length
  );

  if (originalStart === -1 || originalEnd === -1) return null;

  return content.slice(0, originalStart) + newStr + content.slice(originalEnd);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, " ").replace(/\r\n/g, "\n");
}

/**
 * Map a position in the normalized string back to the original string.
 * Walks both strings char-by-char, skipping extra whitespace in the original.
 */
function mapToOriginal(
  original: string,
  _normalized: string,
  normalizedPos: number
): number {
  let ni = 0;
  let oi = 0;

  while (ni < normalizedPos && oi < original.length) {
    const oc = original[oi];
    if (oc === "\r" && original[oi + 1] === "\n") {
      // \r\n in original maps to \n in normalized
      oi += 2;
      ni += 1;
    } else if (oc === " " || oc === "\t") {
      // Consume a run of spaces/tabs in original → single space in normalized
      oi++;
      while (
        oi < original.length &&
        (original[oi] === " " || original[oi] === "\t")
      ) {
        oi++;
      }
      ni++;
    } else {
      oi++;
      ni++;
    }
  }

  return oi;
}
