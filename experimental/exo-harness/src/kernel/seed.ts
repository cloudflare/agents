/**
 * Seed harness — the agent's "self" at version 1 (genesis).
 *
 * Everything under /harness is the agent's own evolvable source: it can read
 * and rewrite these files with its kernel file tools, then commit a new
 * version with `activate_harness`. The kernel (server.ts + this directory)
 * is the stable, non-editable layer.
 */

export const SEED_IDENTITY = `# Identity

PERSONA: precise, helpful, curious.

You are Exo, an experimental self-modifying agent running on Cloudflare.

Operating rules:

- Be direct and concrete. Prefer doing over describing.
- When asked to change how you behave, edit your own harness files under
  /harness and then call activate_harness to commit the new version.
- Record anything important for your future self with journal_note.
- When an experiment goes wrong, use rollback_harness to return to a known
  good version, then explain what happened by reading the journal.
`;

export const SEED_POLICY = `{
  "model": "workers-ai:@cf/moonshotai/kimi-k2.7-code",
  "maxSteps": 8
}
`;

export const SEED_CONTEXT = `{
  "keepMessages": 40,
  "tokenTarget": 6000,
  "memoryFile": "/memory/core.md",
  "memoryMaxChars": 4000
}
`;

export const SEED_TOOL_ECHO = `// A minimal example harness tool. Harness tools are plain ES modules that
// export a default object with: name, description, inputSchema (JSON Schema),
// and an async run(input, caps) handler. They execute inside an isolated
// dynamic Worker with no network access; caps.state is the workspace
// filesystem and caps.journal.note(text) appends to the durable journal.
export default {
  name: "echo",
  description:
    "Echo a message back, optionally uppercased. A template for new tools.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Text to echo back" },
      uppercase: { type: "boolean", description: "Return it uppercased" }
    },
    required: ["message"]
  },
  async run(input, caps) {
    const text = input.uppercase ? input.message.toUpperCase() : input.message;
    await caps.journal.note("echo tool ran: " + text);
    return { echoed: text };
  }
};
`;

export const SEED_SCRATCH_README = `# Scratch

Free working space for the agent. Files here are part of the workspace but
not part of the harness — editing them never changes agent behavior.
`;

/** All genesis files, keyed by absolute workspace path. */
export const SEED_FILES: Record<string, string> = {
  "/harness/identity.md": SEED_IDENTITY,
  "/harness/policy.json": SEED_POLICY,
  "/harness/context.json": SEED_CONTEXT,
  "/harness/tools/echo.js": SEED_TOOL_ECHO,
  "/scratch/README.md": SEED_SCRATCH_README
};
