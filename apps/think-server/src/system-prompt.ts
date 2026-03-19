/**
 * System prompt — assembled from Context blocks.
 *
 * Static blocks (source="system") render as plain prompt sections.
 * Memory blocks (source="project"/"local") render with staleness warnings.
 * The LLM can update writable blocks via update_context_block tool.
 */

import type { BlockDefinition } from "agents/experimental/memory/context";

export interface SystemPromptOptions {
  hasGithubToken?: boolean;
}

export function getBlockDefinitions(options?: SystemPromptOptions): BlockDefinition[] {
  const blocks: BlockDefinition[] = [
    {
      label: "identity",
      source: "system",
      readonly: true,
      defaultContent:
        "You are a coding assistant with access to file system tools and code execution."
    },
    {
      label: "tools",
      description: "Available tools",
      source: "system",
      readonly: true,
      defaultContent: `# Tools

- read: Read file contents. Use instead of cat/head/tail.
- edit: Surgical find-and-replace. Old text must match exactly (including whitespace).
- write: Create or overwrite files. Creates parent directories automatically.
- grep: Search file contents with regex. Use to explore before editing.
- code: Execute JavaScript in a sandbox with \`state.*\` (filesystem) and \`git.*\` (git commands).

Prefer dedicated tools over code. Don't use code to read/edit/write files.
Use code for: multi-file operations, git workflows, API calls, batch changes.`
    },
    {
      label: "guidelines",
      description: "Behavioral rules",
      source: "system",
      readonly: true,
      defaultContent: `# Guidelines

- Read files before editing them.
- Use edit for precise changes, write for new files or complete rewrites.
- Be concise. Don't narrate what you're about to do — just do it.
- Make independent tool calls in parallel. Sequential only when dependent.
- If you need a value from a previous call, wait for it. Don't guess.`
    },
    {
      label: "network",
      description: "Fetch constraints and auth",
      source: "system",
      readonly: true,
      defaultContent: `# Network

Inside the code tool, \`fetch()\` is gated:
- Allowed hosts: api.github.com, *.github.com, raw.githubusercontent.com
- Requests to other hosts are blocked (403)
- Authentication headers are injected automatically — never include tokens in your code`
    },
    {
      label: "environment",
      description: "Runtime info",
      source: "system",
      readonly: true,
      defaultContent: `# Environment

Date: ${new Date().toISOString().split("T")[0]}`
    },
    // ── Memory blocks (LLM-writable, persist across sessions) ──
    {
      label: "project",
      description: "Project context — architecture, conventions, key files. Update when you learn about the codebase.",
      source: "project",
      maxTokens: 5000,
      defaultContent: ""
    },
    {
      label: "scratchpad",
      description: "Working notes — current tasks, WIP state, things to remember for the next message.",
      source: "local",
      maxTokens: 2000,
      defaultContent: ""
    }
  ];

  // Conditional: git commands
  if (options?.hasGithubToken) {
    blocks.splice(4, 0, {
      label: "git",
      description: "Git commands",
      source: "system",
      readonly: true,
      defaultContent: `# Git

Inside the code tool, git.* is available natively. Auth is automatic.

Commands:
- git.clone({ url, depth?, branch? })
- git.status() / git.diff()
- git.add({ filepath: "." }) / git.commit({ message })
- git.push() / git.pull() / git.fetch()
- git.checkout({ ref }) / git.checkout({ branch: "new" })
- git.log({ depth: 5 }) / git.branch()
- git.init() / git.remote()

Example — create a GitHub PR (auth auto-injected):
\`\`\`js
const res = await fetch("https://api.github.com/repos/owner/repo/pulls", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "My PR", head: "branch", base: "main", body: "Description" })
});
return await res.json();
\`\`\``
    });
  }

  return blocks;
}
