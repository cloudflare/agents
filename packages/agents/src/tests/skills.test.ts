import { describe, expect, it } from "vitest";
import * as skills from "../skills";
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
        },
        {
          path: "scripts/not-a-script.txt",
          kind: "file",
          content: "Not executable."
        },
        {
          path: "scripts/not-a-script.js",
          kind: "file",
          content: "Not executable."
        },
        {
          path: "assets/logo.png",
          kind: "asset",
          encoding: "base64",
          mimeType: "image/png",
          content: "aGVsbG8="
        },
        {
          path: "../input.json",
          kind: "file",
          content: "unsafe"
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
      resources: [
        { path: "scripts/review.ts", kind: "script" },
        { path: "scripts/not-a-script.txt", kind: "file" },
        { path: "scripts/not-a-script.js", kind: "file" },
        { path: "assets/logo.png", kind: "asset", encoding: "base64" }
      ]
    });

    await expect(
      source.readResource?.("code-review", "scripts/review.ts")
    ).resolves.toMatchObject({
      content: "export default function review() {}"
    });
    await expect(
      source.readResource?.("code-review", "assets/logo.png")
    ).resolves.toMatchObject({
      encoding: "base64",
      mimeType: "image/png",
      content: "aGVsbG8="
    });
    await expect(
      source.readResource?.("code-review", "../input.json")
    ).resolves.toBeNull();
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

    const qualified = await executable(tools.read_skill_resource).execute({
      path: "always-on/references/rules.md"
    });
    expect(qualified).toContain('name="always-on"');
    expect(qualified).toContain("Rules reference");

    const binary = await executable(tools.read_skill_resource).execute({
      path: "code-review/assets/logo.png"
    });
    expect(binary).toContain('encoding="base64"');
    expect(binary).toContain('mimeType="image/png"');
    expect(binary).toContain("aGVsbG8=");
  });

  it("exposes run_skill_script only when a runner is configured", async () => {
    const withoutRunner = new SkillRegistry([skills.fromManifest(manifest)]);
    await withoutRunner.load();
    expect(withoutRunner.tools()).not.toHaveProperty("run_skill_script");

    const registry = new SkillRegistry([skills.fromManifest(manifest)], {
      async run(request) {
        return {
          skill: request.skill.name,
          path: request.path,
          source: request.source,
          input: request.input
        };
      }
    });
    await registry.load();

    const tools = registry.tools();
    expect(tools).toHaveProperty("run_skill_script");

    const result = await executable(tools.run_skill_script).execute({
      name: "code-review",
      path: "scripts/review.ts",
      input: { diff: "test" }
    });

    expect(result).toMatchObject({
      skill: "code-review",
      path: "scripts/review.ts",
      source: "export default function review() {}",
      input: { diff: "test" }
    });

    const defaultInput = await executable(tools.run_skill_script).execute({
      name: "code-review",
      path: "scripts/review.ts"
    });

    expect(defaultInput).toMatchObject({
      input: {}
    });
  });

  it("rejects non-script resources for run_skill_script", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)], {
      async run() {
        return "should not run";
      }
    });
    await registry.load();

    const result = await executable(registry.tools().run_skill_script).execute({
      name: "always-on",
      path: "references/rules.md",
      input: {}
    });

    expect(result).toContain('must start with "scripts/"');
  });

  it("rejects missing script resources for run_skill_script", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)], {
      async run() {
        return "should not run";
      }
    });
    await registry.load();

    const result = await executable(registry.tools().run_skill_script).execute({
      name: "code-review",
      path: "scripts/missing.ts",
      input: {}
    });

    expect(result).toContain(
      "Script not found: code-review/scripts/missing.ts"
    );
  });

  it("rejects unsupported script extensions for run_skill_script", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)], {
      async run() {
        return "should not run";
      }
    });
    await registry.load();

    const result = await executable(registry.tools().run_skill_script).execute({
      name: "code-review",
      path: "scripts/not-a-script.txt",
      input: {}
    });

    expect(result).toContain('Unsupported skill script extension ".txt"');
  });

  it("rejects non-normalized script paths for run_skill_script", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)], {
      async run() {
        return "should not run";
      }
    });
    await registry.load();

    const result = await executable(registry.tools().run_skill_script).execute({
      name: "code-review",
      path: "scripts/../references/rules.md",
      input: {}
    });

    expect(result).toContain("normalized relative path");
  });

  it("rejects resources under scripts that are not script resources", async () => {
    const registry = new SkillRegistry([skills.fromManifest(manifest)], {
      async run() {
        return "should not run";
      }
    });
    await registry.load();

    const result = await executable(registry.tools().run_skill_script).execute({
      name: "code-review",
      path: "scripts/not-a-script.js",
      input: {}
    });

    expect(result).toContain(
      "Resource is not a script: code-review/scripts/not-a-script.js"
    );
  });

  it("keeps the first source on duplicate skill names and records a warning", async () => {
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

    await expect(registry.load()).resolves.toBeUndefined();

    // First source wins; the collision is reported, not thrown.
    await expect(registry.loadSkill("code-review")).resolves.toMatchObject({
      description: "Review code when asked."
    });
    expect(registry.warnings.join("\n")).toContain(
      'Duplicate skill "code-review"'
    );
  });

  it("skips a source that fails to list without breaking others", async () => {
    const failingSource = {
      id: "broken-source",
      fingerprint: "v1",
      async list(): Promise<never> {
        throw new Error("list exploded");
      },
      async load() {
        return null;
      }
    };

    const registry = new SkillRegistry([
      failingSource,
      skills.fromManifest(manifest)
    ]);

    await expect(registry.load()).resolves.toBeUndefined();

    // The healthy source still loads.
    const snapshot = await registry.snapshot();
    expect(snapshot.catalogPrompt).toContain("code-review");
    expect(registry.warnings.join("\n")).toContain("broken-source");
  });

  it("resets warnings on each load", async () => {
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

    await registry.refresh();
    const first = registry.warnings.length;
    await registry.refresh();
    expect(registry.warnings.length).toBe(first);
  });
});
