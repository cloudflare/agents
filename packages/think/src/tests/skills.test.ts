import { describe, expect, it } from "vitest";
import { skills } from "../think";
import { SkillRegistry } from "../skills";
import type { SkillManifest } from "../skills";

type ExecutableTool = {
  execute(input: Record<string, unknown>): Promise<unknown> | unknown;
};

function executable(tool: unknown): ExecutableTool {
  return tool as ExecutableTool;
}

const manifest: SkillManifest = {
  id: "test",
  fingerprint: "v1",
  skills: [
    {
      name: "always-on",
      description: "Pinned behavior",
      body: "Always follow this.",
      resources: [
        {
          path: "references/rules.md",
          kind: "reference",
          content: "Rules reference"
        }
      ]
    },
    {
      name: "code-review",
      description: "Review code when asked.",
      body: "Review carefully.",
      resources: [
        {
          path: "scripts/review.ts",
          kind: "script",
          content: "export default function review() {}"
        }
      ]
    },
    {
      name: "docs-helper",
      description: "Answer docs questions.",
      body: "Manual only."
    }
  ]
};

describe("Think skills", () => {
  it("parses SKILL.md YAML frontmatter", () => {
    const parsed = skills.parseSkillMarkdown(`---
name: code-review
description: Review code when asked.
allowed-tools: Read Bash(git:*)
metadata:
  owner: test
---
# Instructions
Review carefully.
`);

    expect(parsed).toEqual({
      name: "code-review",
      description: "Review code when asked.",
      allowedTools: "Read Bash(git:*)",
      body: "# Instructions\nReview carefully.\n",
      metadata: { owner: "test" },
      compatibility: undefined,
      license: undefined
    });
  });

  it("creates a source from a manifest", async () => {
    const source = skills.fromManifest(manifest);

    await expect(source.list()).resolves.toMatchObject([
      { name: "always-on" },
      { name: "code-review" },
      { name: "docs-helper" }
    ]);

    await expect(source.load("code-review")).resolves.toMatchObject({
      name: "code-review",
      body: "Review carefully.",
      resources: [{ path: "scripts/review.ts", kind: "script" }]
    });

    await expect(
      source.readResource?.("code-review", "scripts/review.ts")
    ).resolves.toMatchObject({
      content: "export default function review() {}"
    });
  });

  it("renders all skills in the model catalog", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)]);
    await registry.load();

    const snapshot = await registry.snapshot();
    expect(snapshot).not.toHaveProperty("pinnedPrompt");
    expect(snapshot.catalogPrompt).toContain("always-on: Pinned behavior");
    expect(snapshot.catalogPrompt).toContain(
      "code-review: Review code when asked."
    );
    expect(snapshot.catalogPrompt).toContain(
      "docs-helper: Answer docs questions."
    );
  });

  it("exposes skill tools for model-visible skills", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)]);
    await registry.load();

    const tools = registry.tools();
    expect(tools).toHaveProperty("activate_skill");
    expect(tools).not.toHaveProperty("unload_skill");
    expect(tools).toHaveProperty("read_skill_resource");

    const activated = await executable(tools.activate_skill).execute({
      name: "code-review"
    });
    expect(activated).toContain('<skill_content name="code-review">');
    expect(activated).toContain("Review carefully.");

    const resource = await executable(tools.read_skill_resource).execute({
      name: "code-review",
      path: "scripts/review.ts"
    });
    expect(resource).toContain("<skill_resource");
    expect(resource).toContain("export default function review");
  });

  it("rejects duplicate skill names across sources", async () => {
    const registry = new SkillRegistry([
      skills.fromManifest(manifest),
      skills.fromManifest({
        id: "duplicate",
        fingerprint: "v1",
        skills: [
          {
            name: "code-review",
            description: "Duplicate review skill.",
            body: "Duplicate."
          }
        ]
      })
    ]);

    await expect(registry.load()).rejects.toThrow(
      'Duplicate skill "code-review"'
    );
  });
});
