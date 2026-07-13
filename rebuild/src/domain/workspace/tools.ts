import { z } from "zod";
import { truncateForModel } from "../../kernel/json.js";
import { tool, type ToolSet } from "../tools/types.js";
import type { Workspace } from "./workspace.js";

export interface WorkspaceToolsOptions {
  /** Character cap applied to every tool's model-facing text output. Default 8000. */
  maxModelChars?: number;
  /** Default line window for `read` when offset/limit are omitted. Default 2000. */
  defaultReadLimit?: number;
  /** Default cap on `grep` matches. Default 100. */
  defaultGrepMaxMatches?: number;
}

type ErrorValue = { error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + needle.length;
  }
  return count;
}

/**
 * `createWorkspaceTools` builds the LLM-facing file tools over a `Workspace`.
 * Every tool carries `metadata.capability = "workspace"`. `bash` is
 * intentionally omitted — it lives behind a future Sandbox-backed tool.
 */
export function createWorkspaceTools(ws: Workspace, opts?: WorkspaceToolsOptions): ToolSet {
  const maxModelChars = opts?.maxModelChars ?? 8000;
  const defaultReadLimit = opts?.defaultReadLimit ?? 2000;
  const defaultGrepMaxMatches = opts?.defaultGrepMaxMatches ?? 100;

  function bound(text: string): string {
    return truncateForModel(text, maxModelChars).text;
  }

  const metadata = { capability: "workspace" as const };

  const read = tool({
    description: "Read a file from the workspace. Text files are returned with line numbers; binary/PDF/image files return a compact descriptor instead of raw bytes.",
    inputSchema: z.object({
      path: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
    metadata,
    execute(input): string | { path: string; mediaType?: string; size: number; note: string } | ErrorValue {
      try {
        const record = ws.read(input.path);
        if (!record) return { error: `${input.path}: no such file` };
        if (record.encoding === "base64") {
          const size = Math.floor((record.content.length * 3) / 4);
          return {
            path: input.path,
            mediaType: record.mediaType,
            size,
            note: "binary content omitted; use a capability that supports binary/media data to view it",
          };
        }
        const offset = input.offset ?? 0;
        const limit = input.limit ?? defaultReadLimit;
        const lines = record.content.split("\n");
        const window = lines.slice(offset, offset + limit);
        const rendered = window.map((line, i) => `${offset + i + 1}→${line}`).join("\n");
        return bound(rendered);
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  });

  const write = tool({
    description: "Create or overwrite a file in the workspace.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    metadata,
    execute(input): { path: string; bytes: number } | ErrorValue {
      try {
        ws.write(input.path, input.content);
        const record = ws.read(input.path);
        const bytes = record ? new TextEncoder().encode(record.content).length : new TextEncoder().encode(input.content).length;
        return { path: input.path, bytes };
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  });

  const edit = tool({
    description: "Replace old_string with new_string in a file. Fails if old_string is not found, or is ambiguous unless replace_all is set.",
    inputSchema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    metadata,
    execute(input): { ok: true } | { ok: false; error: string } {
      try {
        const result = ws.edit(input.path, input.old_string, input.new_string, {
          replaceAll: input.replace_all,
        });
        if (result.ok) return { ok: true };
        if (result.reason === "not_found") return { ok: false, error: `${input.path}: no such file` };
        if (result.reason === "no_match") return { ok: false, error: "old_string not found" };
        const record = ws.read(input.path);
        const occurrences = record ? countOccurrences(record.content, input.old_string) : 0;
        return {
          ok: false,
          error: `old_string appears ${occurrences} times — provide more context or replace_all`,
        };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  });

  const list = tool({
    description: "List workspace entries with their sizes.",
    inputSchema: z.object({ path: z.string().optional(), recursive: z.boolean().optional() }),
    metadata,
    execute(input): string | ErrorValue {
      try {
        const entries = ws.list(input.path, { recursive: input.recursive });
        return bound(entries.map((e) => `${e.path}\t${e.size}`).join("\n"));
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  });

  const find = tool({
    description: "Find workspace paths matching a glob pattern (** matches across directories, * within one).",
    inputSchema: z.object({ pattern: z.string() }),
    metadata,
    execute(input): string | ErrorValue {
      try {
        const matches = ws.find(input.pattern).slice().sort();
        return bound(matches.join("\n"));
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  });

  const grep = tool({
    description: "Search workspace text files by regex, optionally scoped by glob. Returns path:line: text rows.",
    inputSchema: z.object({
      pattern: z.string(),
      glob: z.string().optional(),
      max_matches: z.number().int().min(1).optional(),
    }),
    metadata,
    execute(input): string | ErrorValue {
      try {
        const results = ws.grep(input.pattern, {
          glob: input.glob,
          maxMatches: input.max_matches ?? defaultGrepMaxMatches,
        });
        return bound(results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n"));
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  });

  const del = tool({
    description: "Delete a file (or everything under a directory) from the workspace.",
    inputSchema: z.object({ path: z.string() }),
    metadata,
    execute(input): { deleted: boolean } | ErrorValue {
      try {
        return { deleted: ws.delete(input.path) };
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  });

  return { read, write, edit, list, find, grep, delete: del };
}

export type { ErrorValue as WorkspaceToolErrorValue };
