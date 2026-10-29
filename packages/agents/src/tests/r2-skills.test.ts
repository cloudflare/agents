import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as skills from "../skills";

const bucket = env.SKILLS_BUCKET;

/** A unique prefix per test, so tests sharing the bucket never collide. */
async function seed(
  files: Record<string, string | Uint8Array>
): Promise<string> {
  const prefix = `skills-${crypto.randomUUID()}/`;
  for (const [key, content] of Object.entries(files)) {
    await bucket.put(`${prefix}${key}`, content);
  }
  return prefix;
}

function resourceRef(skill: string, path: string) {
  const name = skills.parseSkillName(skill);
  const resource = skills.parseSkillResourcePath(path);
  if (!name.ok) throw name.error;
  if (!resource.ok) throw resource.error;
  return [name.value, resource.value] as const;
}

const codeReview = `---
name: code-review
description: Review code when asked.
allowed-tools: Read
---

Review carefully.`;

describe("R2 skill source", () => {
  it("lists Agent Skills directories under the prefix", async () => {
    const prefix = await seed({
      "code-review/SKILL.md": codeReview,
      "code-review/references/checklist.md": "Check tests.",
      "code-review/scripts/review.js": "export default () => 1;",
      "README.md": "not a skill",
      "nested/deeper/SKILL.md": "not one level deep"
    });

    const listed = await skills.r2(bucket, { prefix }).list();
    if (!listed.ok) throw listed.error;
    expect(listed.value.invalid).toEqual([]);
    expect(listed.value.skills).toHaveLength(1);
    const [entry] = listed.value.skills;
    expect(entry?.skill).toMatchObject({
      name: "code-review",
      description: "Review code when asked.",
      allowedTools: ["Read"]
    });
    expect(entry?.resources).toEqual([
      {
        path: "references/checklist.md",
        kind: "reference",
        encoding: "text",
        mimeType: "text/markdown",
        size: 12
      },
      {
        path: "scripts/review.js",
        kind: "script",
        encoding: "text",
        mimeType: "text/javascript",
        size: 23
      }
    ]);
  });

  it("reads text and binary resources", async () => {
    const prefix = await seed({
      "code-review/SKILL.md": codeReview,
      "code-review/references/checklist.md": "Check tests.",
      "code-review/assets/logo.png": new Uint8Array([104, 105])
    });
    const catalog = await skills.loadSkillCatalog([
      skills.r2(bucket, { prefix })
    ]);

    const text = await catalog.readResource({
      name: "code-review",
      path: "references/checklist.md"
    });
    expect(text.ok && text.value.resource.content).toBe("Check tests.");

    const binary = await catalog.readResource({
      path: "code-review/assets/logo.png"
    });
    expect(binary.ok && binary.value.resource).toMatchObject({
      encoding: "base64",
      mimeType: "image/png",
      content: "aGk="
    });
  });

  it("reads resources without listing the bucket again", async () => {
    const prefix = await seed({ "code-review/SKILL.md": codeReview });
    const source = skills.r2(bucket, {
      prefix,
      skills: ["code-review"],
      refreshIntervalMs: 0
    });
    await source.list();
    // Written after the listing; a direct read still finds it.
    await bucket.put(`${prefix}code-review/references/late.md`, "late");
    const read = await source.readResource(
      ...resourceRef("code-review", "references/late.md")
    );
    expect(read.ok && read.value).toMatchObject({
      kind: "reference",
      encoding: "text",
      size: 4,
      content: "late"
    });

    const missing = await source.readResource(
      ...resourceRef("code-review", "references/nope.md")
    );
    expect(missing.ok || missing.error._tag).toBe("SkillResourceNotFoundError");
  });

  it("loads skills that break the spec, with warnings", async () => {
    const prefix = await seed({
      "Code-Review/SKILL.md": codeReview.replace(
        "name: code-review",
        "name: Code-Review"
      ),
      "other/SKILL.md": codeReview
    });
    const source = skills.r2(bucket, { prefix });
    const listed = await source.list();
    if (!listed.ok) throw listed.error;
    expect(listed.value.invalid).toEqual([]);
    expect(
      listed.value.skills.map(({ skill, warnings }) => [
        skill.name,
        warnings?.map((warning) => warning.code)
      ])
    ).toEqual([
      ["Code-Review", ["invalid-name"]],
      ["code-review", ["name-mismatch"]]
    ]);
  });

  it("filters to an allowlist of skill names", async () => {
    const prefix = await seed({
      "code-review/SKILL.md": codeReview,
      "docs/SKILL.md": "---\nname: docs\ndescription: Docs.\n---\n"
    });
    const listed = await skills.r2(bucket, { prefix, skills: ["docs"] }).list();
    expect(
      listed.ok && listed.value.skills.map(({ skill }) => skill.name)
    ).toEqual(["docs"]);
  });

  it("reuses a listing until the refresh interval passes", async () => {
    const prefix = await seed({ "code-review/SKILL.md": codeReview });
    const cached = skills.r2(bucket, { prefix });
    const live = skills.r2(bucket, { prefix, refreshIntervalMs: 0 });
    await cached.list();

    await bucket.put(
      `${prefix}docs/SKILL.md`,
      "---\nname: docs\ndescription: Docs.\n---\n"
    );

    const names = async (source: skills.SkillSource) => {
      const listed = await source.list();
      return listed.ok
        ? listed.value.skills.map(({ skill }) => skill.name)
        : [];
    };
    expect(await names(cached)).toEqual(["code-review"]);
    expect(await names(live)).toEqual(["code-review", "docs"]);
  });
});
