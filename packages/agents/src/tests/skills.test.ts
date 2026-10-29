import { describe, expect, it } from "vitest";
import * as skills from "../skills";
import { createSkillTools } from "../skills/tools/ai-sdk";
import type { SkillManifest, SkillSource } from "../skills";
import { MemorySkillWorkspace } from "./memory-skill-workspace";

type ExecutableTool = {
  execute(input: Record<string, unknown>): Promise<unknown> | unknown;
};

function executable(tool: unknown): ExecutableTool {
  // SAFETY: AI SDK tools expose `execute`; the test calls it directly with
  // inputs the tool schema accepts.
  return tool as ExecutableTool;
}

function skillFile(
  frontmatter: Record<string, string>,
  body = "Follow the steps."
): string {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${value}`
  );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function parseError(markdown: string, directory?: string): string {
  const parsed = skills.parseSkill(
    markdown,
    directory === undefined ? {} : { directory }
  );
  if (parsed.ok) throw new Error("expected a parse error");
  return parsed.error.code;
}

const testManifest: SkillManifest = {
  id: "test",
  skills: [
    {
      name: "always-on",
      description: "Pinned behavior",
      body: "Always follow this.",
      resources: [{ path: "references/rules.md", content: "Rules reference" }]
    },
    {
      name: "code-review",
      description: "Review code when asked.",
      body: "Review carefully.",
      resources: [
        {
          path: "scripts/review.js",
          content: "export default function review() {}"
        },
        { path: "assets/logo.png", content: "aGVsbG8=" },
        { path: "../input.json", content: "unsafe" }
      ]
    },
    {
      name: "docs-helper",
      description: "Answer docs questions.",
      body: "Manual only."
    }
  ]
};

describe("parseSkill", () => {
  it("parses spec frontmatter and keeps extra fields", () => {
    const parsed = skills.parseSkill(`---
name: code-review
description: Review code when asked.
license: Apache-2.0
compatibility: Requires git
allowed-tools: Read Bash(git:*)
metadata:
  owner: test
  version: 1.0
disable-model-invocation: true
---

Review carefully.`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      name: "code-review",
      description: "Review code when asked.",
      license: "Apache-2.0",
      compatibility: "Requires git",
      allowedTools: ["Read", "Bash(git:*)"],
      metadata: { owner: "test", version: "1" },
      extraFields: { "disable-model-invocation": true }
    });
    expect(parsed.value.body.trim()).toBe("Review carefully.");
    expect(skills.isModelInvocable(parsed.value)).toBe(false);
  });

  it("round-trips through formatSkill", () => {
    const parsed = skills.parseSkill(
      skillFile({
        name: "round-trip",
        description: "A skill.",
        "allowed-tools": "Read Write",
        "user-invocable": "false"
      })
    );
    if (!parsed.ok) throw parsed.error;
    expect(skills.parseSkill(skills.formatSkill(parsed.value))).toEqual(parsed);
  });

  it("enforces the spec name rules", () => {
    for (const name of [
      "PDF-Processing",
      "-pdf",
      "pdf-",
      "pdf--processing",
      "pdf_processing",
      "a".repeat(65)
    ]) {
      expect(
        parseError(skillFile({ name, description: "A skill." })),
        name
      ).toBe("invalid-name");
    }
    expect(skills.parseSkillName("data-analysis-2").ok).toBe(true);
  });

  it("requires the name to match the directory", () => {
    expect(
      parseError(
        skillFile({ name: "code-review", description: "A skill." }),
        "review"
      )
    ).toBe("name-mismatch");
    expect(
      skills.parseSkill(
        skillFile({ name: "code-review", description: "A skill." }),
        { directory: "code-review" }
      ).ok
    ).toBe(true);
  });

  it("checks required and constrained fields", () => {
    expect(parseError("No frontmatter here.")).toBe("missing-frontmatter");
    expect(parseError("---\nname: [unclosed\n---\n")).toBe("invalid-yaml");
    expect(parseError("---\n- a\n- b\n---\n")).toBe("invalid-frontmatter");
    expect(parseError(skillFile({ description: "A skill." }))).toBe(
      "invalid-name"
    );
    expect(parseError(skillFile({ name: "no-description" }))).toBe(
      "invalid-description"
    );
    expect(
      parseError(skillFile({ name: "long", description: "x".repeat(1025) }))
    ).toBe("invalid-description");
    expect(
      parseError(
        skillFile({
          name: "long",
          description: "A skill.",
          compatibility: "x".repeat(501)
        })
      )
    ).toBe("invalid-compatibility");
    expect(
      parseError(
        "---\nname: nested\ndescription: A skill.\nmetadata:\n  owner:\n    team: x\n---\n"
      )
    ).toBe("invalid-metadata");
    expect(
      parseError(
        "---\nname: tools\ndescription: A skill.\nallowed-tools: 3\n---\n"
      )
    ).toBe("invalid-allowed-tools");
  });

  it("rejects resource paths that escape the skill", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../secret",
      "references/../../x",
      "references//x",
      "SKILL.md"
    ]) {
      expect(skills.parseSkillResourcePath(path).ok, path).toBe(false);
    }
    expect(skills.parseSkillResourcePath("references/guide.md").ok).toBe(true);
  });
});

describe("skill catalog", () => {
  it("lists every model-invocable skill in the prompt", async () => {
    const catalog = await skills.loadSkillCatalog([
      skills.manifest(testManifest)
    ]);

    expect(catalog.prompt()).toContain("- always-on: Pinned behavior");
    expect(catalog.prompt()).toContain(
      "- code-review: Review code when asked."
    );
    expect(catalog.prompt()).toContain("- docs-helper: Answer docs questions.");
    expect(catalog.diagnostics).toEqual([]);
  });

  it("keeps fromManifest as an alias of manifest", () => {
    expect(skills.fromManifest).toBe(skills.manifest);
  });

  it("accepts manifests written for fromManifest", async () => {
    const catalog = await skills.loadSkillCatalog([
      skills.fromManifest({
        id: "legacy",
        fingerprint: "v1",
        skills: [
          {
            name: "legacy-skill",
            description: "Written before manifest().",
            body: "Legacy.",
            version: "1",
            metadata: { revision: 2 },
            resources: [
              { path: "examples.md", kind: "reference", content: "Example" },
              {
                path: "scripts/helper.js",
                kind: "file",
                precompiled: true,
                size: 3,
                content: "x"
              }
            ]
          }
        ]
      })
    ]);
    const entry = catalog.find("legacy-skill");
    expect(entry?.skill.metadata).toEqual({ revision: "2" });
    expect(entry?.resources.map(({ path, kind }) => [path, kind])).toEqual([
      ["examples.md", "reference"],
      ["scripts/helper.js", "file"]
    ]);
  });

  it("has no prompt and a stable fingerprint when there are no skills", async () => {
    const first = await skills.loadSkillCatalog([]);
    const second = await skills.loadSkillCatalog([]);
    expect(first.prompt()).toBeNull();
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("activates skills and lists only safe resources", async () => {
    const catalog = await skills.loadSkillCatalog([
      skills.manifest(testManifest)
    ]);

    const activated = catalog.activate("code-review");
    if (!activated.ok) throw activated.error;
    expect(activated.value).toContain('<skill_content name="code-review">');
    expect(activated.value).toContain("Review carefully.");
    expect(activated.value).toContain(
      '<file kind="script" encoding="text">scripts/review.js</file>'
    );
    expect(activated.value).not.toContain("input.json");

    const missing = catalog.activate("nope");
    expect(missing.ok).toBe(false);
  });

  it("reads resources by name or qualified path", async () => {
    const catalog = await skills.loadSkillCatalog([
      skills.manifest(testManifest)
    ]);

    const named = await catalog.readResource({
      name: "always-on",
      path: "references/rules.md"
    });
    if (!named.ok) throw named.error;
    expect(named.value.resource.content).toBe("Rules reference");

    const binary = await catalog.readResource({
      path: "code-review/assets/logo.png"
    });
    if (!binary.ok) throw binary.error;
    expect(skills.renderSkillResource(binary.value)).toContain(
      'encoding="base64" mimeType="image/png"'
    );

    const escaped = await catalog.readResource({
      name: "code-review",
      path: "../always-on/references/rules.md"
    });
    expect(escaped.ok || escaped.error._tag).toBe(
      "InvalidSkillResourcePathError"
    );

    const unlisted = await catalog.readResource({
      name: "code-review",
      path: "references/missing.md"
    });
    expect(unlisted.ok || unlisted.error._tag).toBe(
      "SkillResourceNotFoundError"
    );
  });

  it("keeps the first source on duplicate names", async () => {
    const catalog = await skills.loadSkillCatalog([
      skills.manifest(testManifest),
      skills.manifest({
        id: "duplicate",
        skills: [
          {
            name: "code-review",
            description: "Duplicate review skill.",
            body: "Duplicate."
          }
        ]
      })
    ]);

    expect(catalog.find("code-review")?.skill.description).toBe(
      "Review code when asked."
    );
    expect(catalog.diagnostics).toEqual([
      {
        _tag: "DuplicateSkill",
        name: "code-review",
        sourceId: "duplicate",
        keptSourceId: "test"
      }
    ]);
  });

  it("reports failing sources and invalid skills without dropping others", async () => {
    const throwing: SkillSource = {
      id: "throwing",
      async list() {
        throw new Error("list exploded");
      },
      async readResource() {
        throw new Error("unreachable");
      }
    };
    const catalog = await skills.loadSkillCatalog([
      throwing,
      skills.manifest({
        id: "mixed",
        skills: [
          { name: "Bad Name", description: "Broken.", body: "" },
          ...testManifest.skills
        ]
      })
    ]);

    expect(catalog.find("code-review")).toBeDefined();
    expect(
      catalog.diagnostics.map((diagnostic) =>
        skills.formatSkillDiagnostic(diagnostic)
      )
    ).toEqual([
      'Skill source "throwing" failed to list skills: list exploded. Its skills were skipped.',
      'Skipped invalid skill mixed:Bad Name from source "mixed": Invalid skill name "Bad Name": it must be lowercase.'
    ]);
  });

  it("keeps a failing source's last skills when given the previous catalog", async () => {
    let failing = false;
    const base = skills.manifest(testManifest);
    const flaky: SkillSource = {
      id: "flaky",
      async list() {
        if (failing) throw new Error("bucket unavailable");
        return base.list();
      },
      readResource: (skill, path) => base.readResource(skill, path)
    };

    const first = await skills.loadSkillCatalog([flaky]);
    failing = true;
    const kept = await skills.loadSkillCatalog([flaky], { previous: first });
    expect(kept.find("code-review")).toBeDefined();
    expect(kept.fingerprint).toBe(first.fingerprint);
    expect(kept.diagnostics).toMatchObject([
      { _tag: "SourceFailed", sourceId: "flaky", keptPrevious: true }
    ]);
    const read = await kept.readResource({
      path: "always-on/references/rules.md"
    });
    expect(read.ok && read.value.resource.content).toBe("Rules reference");

    // The fallback carries forward across repeated failures.
    const stillKept = await skills.loadSkillCatalog([flaky], {
      previous: kept
    });
    expect(stillKept.find("code-review")).toBeDefined();

    // Without a previous catalog the source is skipped.
    const skipped = await skills.loadSkillCatalog([flaky]);
    expect(skipped.skills).toEqual([]);
    expect(skipped.diagnostics).toMatchObject([{ keptPrevious: false }]);
  });

  it("reads resources from the source that listed the skill when ids collide", async () => {
    const first = skills.manifest({
      id: "same-id",
      skills: [
        {
          name: "first",
          description: "First skill.",
          body: "First.",
          resources: [{ path: "references/a.md", content: "from first" }]
        }
      ]
    });
    const second = skills.manifest({
      id: "same-id",
      skills: [
        {
          name: "second",
          description: "Second skill.",
          body: "Second.",
          resources: [{ path: "references/a.md", content: "from second" }]
        }
      ]
    });
    const catalog = await skills.loadSkillCatalog([first, second]);

    const a = await catalog.readResource({ path: "first/references/a.md" });
    const b = await catalog.readResource({ path: "second/references/a.md" });
    expect(a.ok && a.value.resource.content).toBe("from first");
    expect(b.ok && b.value.resource.content).toBe("from second");
  });

  it("hides skills that disable model invocation", async () => {
    const catalog = await skills.loadSkillCatalog([
      skills.manifest({
        id: "hidden",
        skills: [
          {
            name: "manual-only",
            description: "Run by hand.",
            body: "Manual.",
            metadata: { "disable-model-invocation": "true" }
          }
        ]
      })
    ]);
    expect(catalog.skills).toEqual([]);
    expect(catalog.prompt()).toBeNull();
  });
});

describe("AI SDK skill tools", () => {
  it("exposes activation and resource tools", async () => {
    const tools = createSkillTools(
      await skills.loadSkillCatalog([skills.manifest(testManifest)])
    );
    expect(Object.keys(tools).sort()).toEqual([
      "activate_skill",
      "read_skill_resource"
    ]);

    await expect(
      executable(tools.activate_skill).execute({ name: "code-review" })
    ).resolves.toContain("Review carefully.");
    await expect(
      executable(tools.read_skill_resource).execute({
        path: "always-on/references/rules.md"
      })
    ).resolves.toContain("Rules reference");
  });

  it("has no tools for an empty catalog", async () => {
    expect(createSkillTools(await skills.loadSkillCatalog([]))).toEqual({});
  });

  it("runs scripts with the skill's files when a runner is configured", async () => {
    const tools = createSkillTools(
      await skills.loadSkillCatalog([skills.manifest(testManifest)]),
      {
        scriptRunner: {
          async run(request) {
            return {
              skill: request.skill.name,
              path: request.path,
              source: request.source,
              input: request.input,
              files: request.resources?.map((file) => file.path)
            };
          }
        }
      }
    );

    await expect(
      executable(tools.run_skill_script).execute({
        name: "code-review",
        path: "scripts/review.js",
        input: { diff: "test" }
      })
    ).resolves.toEqual({
      skill: "code-review",
      path: "scripts/review.js",
      source: "export default function review() {}",
      input: { diff: "test" },
      files: ["assets/logo.png", "scripts/review.js"]
    });
    await expect(
      executable(tools.run_skill_script).execute({
        name: "always-on",
        path: "references/rules.md",
        input: {}
      })
    ).resolves.toBe("Resource is not a script: always-on/references/rules.md");
    await expect(
      executable(tools.run_skill_script).execute({
        name: "code-review",
        path: "scripts/missing.js",
        input: {}
      })
    ).resolves.toBe("Resource not found: code-review/scripts/missing.js");
  });
});

describe("workspace skill source", () => {
  const root = "/workspace/.agents/skills";

  it("reads skills and resources from Workspace files", async () => {
    const workspace = new MemorySkillWorkspace({
      [`${root}/code-review/SKILL.md`]: skillFile({
        name: "code-review",
        description: "Review code when asked."
      }),
      [`${root}/code-review/references/checklist.md`]: "Check tests.",
      [`${root}/code-review/assets/logo.png`]: "png bytes",
      [`${root}/code-review/node_modules/dep/index.js`]: "ignored",
      [`${root}/notes.md`]: "not a skill"
    });
    const catalog = await skills.loadSkillCatalog([
      skills.workspace(workspace)
    ]);

    const entry = catalog.find("code-review");
    expect(entry?.location).toBe(`${root}/code-review`);
    expect(entry?.resources.map((resource) => resource.path)).toEqual([
      "assets/logo.png",
      "references/checklist.md"
    ]);
    const activated = catalog.activate("code-review");
    expect(activated.ok && activated.value).toContain(
      `location="${root}/code-review"`
    );

    const reference = await catalog.readResource({
      path: "code-review/references/checklist.md"
    });
    expect(reference.ok && reference.value.resource.content).toBe(
      "Check tests."
    );
    const binary = await catalog.readResource({
      path: "code-review/assets/logo.png"
    });
    expect(binary.ok && binary.value.resource).toMatchObject({
      encoding: "base64",
      content: btoa("png bytes")
    });
  });

  it("picks up skills written, edited, and deleted in the Workspace", async () => {
    const workspace = new MemorySkillWorkspace();
    const source = skills.workspace(workspace);

    const empty = await skills.loadSkillCatalog([source]);
    expect(empty.prompt()).toBeNull();

    await workspace.writeText(
      `${root}/pirate-voice/SKILL.md`,
      skillFile({ name: "pirate-voice", description: "Talk like a pirate." })
    );
    const added = await skills.loadSkillCatalog([source]);
    expect(added.prompt()).toContain("pirate-voice: Talk like a pirate.");
    expect(added.fingerprint).not.toBe(empty.fingerprint);

    await workspace.writeText(
      `${root}/pirate-voice/SKILL.md`,
      skillFile({ name: "pirate-voice", description: "Talk like a parrot." })
    );
    const edited = await skills.loadSkillCatalog([source]);
    expect(edited.prompt()).toContain("pirate-voice: Talk like a parrot.");

    workspace.delete(`${root}/pirate-voice/SKILL.md`);
    const deleted = await skills.loadSkillCatalog([source]);
    expect(deleted.prompt()).toBeNull();
    expect(deleted.fingerprint).toBe(empty.fingerprint);
  });

  it("reports skills that break the spec", async () => {
    const workspace = new MemorySkillWorkspace({
      [`${root}/review/SKILL.md`]: skillFile({
        name: "code-review",
        description: "Mismatched directory."
      })
    });
    const listed = await skills.workspace(workspace).list();
    if (!listed.ok) throw listed.error;
    expect(listed.value.skills).toEqual([]);
    expect(listed.value.invalid).toMatchObject([
      { location: "review/SKILL.md", error: { code: "name-mismatch" } }
    ]);
  });

  it("supports a custom root", async () => {
    const workspace = new MemorySkillWorkspace({
      "/workspace/skills/notes/SKILL.md": skillFile({
        name: "notes",
        description: "Take notes."
      })
    });
    const catalog = await skills.loadSkillCatalog([
      skills.workspace(workspace, { root: "/workspace/skills/" })
    ]);
    expect(catalog.find("notes")?.sourceId).toBe("workspace:/workspace/skills");
    expect(() =>
      skills.workspace(workspace, { root: "relative/skills" })
    ).toThrow(TypeError);
  });
});
