/**
 * Starter skills, uploaded to the bucket the first time the agent starts so
 * the demo works without setup.
 *
 * Each key is an object key under the skills prefix; together they follow the
 * Agent Skills layout (https://agentskills.io/specification):
 * `<skill-name>/SKILL.md` plus optional `scripts/`, `references/`, and
 * `assets/` files. In production, upload skills with
 * `wrangler r2 object put` or your own pipeline instead.
 *
 * TODO: Replace this with Computer's loader for seeding skills once
 * `@cloudflare/computer` ships one.
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

1. Call run_skill_script with path \`scripts/format-release-notes.js\` and
   input \`{ "changes": ["...", "..."] }\`, one string per change.
2. Reply with the formatted notes, then one sentence on anything the user
   should double-check.
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

export default async function formatReleaseNotes(input, ctx) {
  const changes = Array.isArray(input?.changes) ? input.changes : [];
  const grouped = new Map([["Features", []], ["Fixes", []], ["Other", []]]);
  for (const raw of changes) {
    const change = String(raw).trim().replace(/\\.$/, "");
    if (!change) continue;
    const group = GROUPS.find(([, pattern]) => pattern.test(change))?.[0] ?? "Other";
    grouped.get(group).push(change[0].toUpperCase() + change.slice(1));
  }
  const notes = [...grouped]
    .filter(([, lines]) => lines.length > 0)
    .map(([group, lines]) => \`## \${group}\\n\\n\${lines.map((line) => \`- \${line}\`).join("\\n")}\`)
    .join("\\n\\n");
  return { notes, styleGuide: ctx.files["references/style-guide.md"] };
}
`
};
