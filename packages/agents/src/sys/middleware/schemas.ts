/**
 * Zod schemas for tool parameters.
 * These provide type inference AND auto-generate JSON Schema for providers.
 */
import { z } from "zod";

// ============================================================
// Planning
// ============================================================

export const TodoSchema = z.object({
  content: z.string().describe("Task text"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe("Current task state")
});

export const WriteTodosParams = z.object({
  todos: z.array(TodoSchema).describe("Full replacement list of todos")
});

// ============================================================
// Filesystem
// ============================================================

export const ListFilesParams = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Directory to list. Relative paths resolve to home. Use /shared for shared files, /agents/{id} for other agents. Default: home directory"
    )
});

export const ReadFileParams = z.object({
  path: z
    .string()
    .describe(
      "File path. Relative paths resolve to home. Use /shared/... for shared files, /agents/{id}/... for other agents"
    ),
  offset: z.number().int().min(0).optional().describe("Line offset (0-based)"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Max number of lines to read")
});

export const WriteFileParams = z.object({
  path: z
    .string()
    .describe(
      "File path. Relative paths write to home. Use /shared/... for shared files. Cannot write to other agents' homes."
    ),
  content: z.string().describe("File contents")
});

export const EditFileParams = z.object({
  path: z
    .string()
    .describe(
      "File path. Relative paths edit in home. Use /shared/... for shared files. Cannot edit other agents' files."
    ),
  oldString: z
    .string()
    .describe("Exact string to match (must be unique unless replaceAll=true)"),
  newString: z.string().describe("Replacement string (can be empty)"),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of enforcing uniqueness")
});

// ============================================================
// Subagents
// ============================================================

export const TaskParams = z.object({
  description: z.string().describe("Task description for the subagent"),
  subagentType: z.string().describe("Type of subagent to spawn")
});
