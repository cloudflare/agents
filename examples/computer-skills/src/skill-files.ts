/**
 * Starter skills, written into the Workspace the first time the agent starts.
 *
 * Each key is a path under the Workspace skills root; together they follow
 * the Agent Skills layout (https://agentskills.io/specification):
 * `<skill-name>/SKILL.md` plus optional `scripts/`, `references/`, and
 * `assets/` files.
 *
 * TODO: Replace this with Computer's loader for seeding a Workspace from
 * files once `@cloudflare/computer` ships one.
 */
export const STARTER_SKILLS: Record<string, string> = {
  "pirate-voice/SKILL.md": `---
name: pirate-voice
description: Answer in a playful pirate voice. Use when the user asks for a pirate, nautical, or swashbuckling tone.
---

Answer the request accurately, then rewrite the answer in a light pirate voice.

- Keep facts, code, and numbers unchanged.
- Use one or two pirate phrases per paragraph, not every sentence.
`,

  "release-notes/SKILL.md": `---
name: release-notes
description: Turn a list of changes into release notes. Use when the user asks for release notes, a changelog entry, or a summary of shipped changes.
metadata:
  author: agents-sdk-examples
---

1. Read \`references/style-guide.md\` with read_skill_resource.
2. Run the formatter with the \`exec\` tool. Set \`cwd\` to this skill's
   location, use this module as the command:

   \`\`\`js
   export { default } from "./scripts/format-release-notes.js";
   \`\`\`

   and pass \`{ "changes": ["...", "..."] }\` as \`input\`, one string per change.
3. Reply with the formatted notes from the run's \`result\`, then one sentence
   on anything the user should double-check.
`,

  "release-notes/references/style-guide.md": `# Release notes style guide

- Start each line with a verb in the past tense: Added, Fixed, Removed.
- One change per line. No trailing periods.
- Group lines under Features, Fixes, and Other.
`,

  "release-notes/scripts/format-release-notes.js": `const GROUPS = [
  ["Features", /^(add|introduc|support|new)/i],
  ["Fixes", /^(fix|resolv|correct)/i]
];

export default async function formatReleaseNotes(input) {
  const changes = Array.isArray(input?.changes) ? input.changes : [];
  const grouped = new Map([["Features", []], ["Fixes", []], ["Other", []]]);
  for (const raw of changes) {
    const change = String(raw).trim().replace(/\\.$/, "");
    if (!change) continue;
    const group = GROUPS.find(([, pattern]) => pattern.test(change))?.[0] ?? "Other";
    grouped.get(group).push(change[0].toUpperCase() + change.slice(1));
  }
  return [...grouped]
    .filter(([, lines]) => lines.length > 0)
    .map(([group, lines]) => \`## \${group}\\n\\n\${lines.map((line) => \`- \${line}\`).join("\\n")}\`)
    .join("\\n\\n");
}
`,

  "workspace-digest/SKILL.md": `---
name: workspace-digest
description: Summarize what is in the agent's Workspace. Use when the user asks what files exist, how big the Workspace is, or for an overview of their files.
---

Run the digest with the \`exec\` tool. Set \`cwd\` to this skill's location and
use this module as the command:

\`\`\`js
export { default } from "./scripts/digest.js";
\`\`\`

Pass \`{ "root": "/workspace" }\` as \`input\`. Summarize the \`result\` in a short
table: path, size, and a one-line guess at what each top-level folder is for.
`,

  "workspace-digest/scripts/digest.js": `import { readdir, stat } from "node:fs/promises";

export default async function digest(input) {
  const root = typeof input?.root === "string" ? input.root : "/workspace";
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = \`\${directory}/\${entry.name}\`;
      if (entry.isDirectory()) await walk(path);
      else files.push({ path, size: (await stat(path)).size });
    }
  }
  await walk(root);
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    largest: files.sort((a, b) => b.size - a.size).slice(0, 10)
  };
}
`
};
