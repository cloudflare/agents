import type { FileInfo } from "./workspace";
import { DONE_TOOL_NAME } from "./tools";

// ── System prompt ──────────────────────────────────────────────────────────

/**
 * Build the system prompt for each agent run.
 *
 * When a workspace is attached, the prompt includes a live snapshot of the
 * top-level directory so the agent knows what already exists before it starts.
 * This prevents re-creating files, helps with navigation, and gives the model
 * accurate context about the project structure from the very first step.
 *
 * @param workspaceFiles - Top-level entries from listFiles("/"), or null when
 *   no workspace is attached to this thread.
 */
export function buildSystemPrompt(workspaceFiles: FileInfo[] | null): string {
  const base = `\
You are Think, an expert coding assistant running inside a Cloudflare Worker. \
You are precise, concise, and thorough. You write clean, idiomatic code and \
explain your reasoning only when it adds value.

## Behaviour

- Think step-by-step before acting. Plan before writing code.
- Prefer \`bash\` for multi-step operations (find, grep, chained edits). \
Use individual file tools for targeted reads and writes.
- Always read a file before editing it to avoid overwriting existing work.
- If a task cannot be completed (missing info, impossible requirement), \
say so clearly rather than guessing.
- When you have finished the task, call \`${DONE_TOOL_NAME}\` with a concise \
summary of what you did. Do NOT call \`${DONE_TOOL_NAME}\` before the work is complete.

## Workspace rules

- All paths are absolute and rooted at \`/\`. Example: \`/src/index.ts\`.
- The workspace is persistent — changes survive across sessions.
- \`bash\` has access to standard Unix commands. Working directory starts at \`/\`. \
Environment variables and cwd do NOT persist between separate \`bash\` calls.`;

  if (!workspaceFiles) {
    return (
      base +
      "\n\n## Mode\n\nNo workspace is attached. Answer questions and help with code, but you cannot read or write files."
    );
  }

  const snapshot = renderFileTree(workspaceFiles);
  const isEmpty = workspaceFiles.length === 0;

  return (
    base +
    "\n\n## Workspace\n\n" +
    (isEmpty
      ? "The workspace is empty. Create any files or directories you need."
      : `Current top-level contents of the workspace:\n\n\`\`\`\n${snapshot}\n\`\`\`\n\nUse \`listFiles\` to explore subdirectories, \`readFile\` to inspect specific files.`)
  );
}

/**
 * Render a flat `listFiles` result as a compact icon-prefixed listing.
 * Directories use 📁, files use 📄 with a size hint.
 */
export function renderFileTree(entries: FileInfo[]): string {
  if (entries.length === 0) return "(empty)";
  return entries
    .map((e) => {
      const icon = e.type === "directory" ? "📁" : "📄";
      const size =
        e.type === "file"
          ? ` (${e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`})`
          : "";
      return `${icon} ${e.name}${size}`;
    })
    .join("\n");
}
