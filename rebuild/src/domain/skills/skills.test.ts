import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { systemClock } from "../../ports/clock.js";
import { createWorkspace } from "../workspace/workspace.js";
import {
  createSkillRegistry,
  fromManifest,
  fromWorkspace,
  parseFrontmatter,
  type SkillDefinition,
  type SkillSource,
} from "./skills.js";

function skill(name: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `does ${name}`,
    instructions: `Instructions for ${name}.`,
    resources: {},
    ...overrides,
  };
}

describe("parseFrontmatter", () => {
  it("parses a frontmatter block into attributes and body", () => {
    const md = "---\nname: foo\ndescription: does the foo thing\n---\nBody line one\nBody line two";
    const result = parseFrontmatter(md);
    expect(result.attributes).toEqual({ name: "foo", description: "does the foo thing" });
    expect(result.body).toBe("Body line one\nBody line two");
  });

  it("returns empty attributes and the whole text as body when there is no frontmatter block", () => {
    const md = "Just a plain body, no frontmatter.";
    const result = parseFrontmatter(md);
    expect(result.attributes).toEqual({});
    expect(result.body).toBe(md);
  });

  it("preserves unknown top-level keys", () => {
    const md = "---\nname: foo\nversion: 1.2\nauthor: someone\n---\nBody";
    const result = parseFrontmatter(md);
    expect(result.attributes).toEqual({ name: "foo", version: "1.2", author: "someone" });
    expect(result.body).toBe("Body");
  });

  it("strips matching quotes around values", () => {
    const md = '---\nname: "quoted name"\ndescription: \'single quoted\'\n---\nBody';
    const result = parseFrontmatter(md);
    expect(result.attributes).toEqual({ name: "quoted name", description: "single quoted" });
  });

  it("treats an unterminated frontmatter block as no frontmatter", () => {
    const md = "---\nname: foo\nBody without closing marker";
    const result = parseFrontmatter(md);
    expect(result.attributes).toEqual({});
    expect(result.body).toBe(md);
  });
});

describe("createSkillRegistry", () => {
  it("registers skills from a single manifest source", async () => {
    const registry = await createSkillRegistry([fromManifest([skill("alpha"), skill("beta")])]);
    expect(registry.skills().map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(registry.get("alpha")?.description).toBe("does alpha");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.warnings()).toEqual([]);
  });

  it("first source to register a name wins; duplicates are skipped with a warning", async () => {
    const first = fromManifest([skill("alpha", { description: "first version" })]);
    const second = fromManifest([skill("alpha", { description: "second version" }), skill("beta")]);
    const registry = await createSkillRegistry([first, second]);

    expect(registry.get("alpha")?.description).toBe("first version");
    expect(registry.skills().map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(registry.warnings()).toHaveLength(1);
    expect(registry.warnings()[0]).toMatch(/alpha/);
  });

  it("skips a failing source with a warning and keeps loading the rest", async () => {
    const failing: SkillSource = {
      id: "broken",
      list: async () => {
        throw new Error("disk on fire");
      },
    };
    const registry = await createSkillRegistry([failing, fromManifest([skill("alpha")])]);

    expect(registry.skills().map((s) => s.name)).toEqual(["alpha"]);
    expect(registry.warnings()).toHaveLength(1);
    expect(registry.warnings()[0]).toMatch(/broken/);
    expect(registry.warnings()[0]).toMatch(/disk on fire/);
  });

  describe("catalogBlock", () => {
    it("is empty when there are no skills", async () => {
      const registry = await createSkillRegistry([]);
      expect(registry.catalogBlock()).toBe("");
    });

    it("is deterministic and lists name — description for each skill", async () => {
      const registry = await createSkillRegistry([fromManifest([skill("alpha"), skill("beta")])]);
      const block1 = registry.catalogBlock();
      const block2 = registry.catalogBlock();
      expect(block1).toBe(block2);
      expect(block1).toContain("alpha — does alpha");
      expect(block1).toContain("beta — does beta");
      expect(block1).toMatch(/activate_skill/);
    });
  });

  describe("tools", () => {
    it("is empty when there are no skills", async () => {
      const registry = await createSkillRegistry([]);
      expect(registry.tools()).toEqual({});
    });

    it("exposes activate_skill and read_skill_resource with skills capability metadata", async () => {
      const registry = await createSkillRegistry([fromManifest([skill("alpha")])]);
      const tools = registry.tools();
      expect(Object.keys(tools).sort()).toEqual(["activate_skill", "read_skill_resource"]);
      expect(tools.activate_skill?.metadata?.capability).toBe("skills");
      expect(tools.read_skill_resource?.metadata?.capability).toBe("skills");
    });

    it("activate_skill returns the skill's full instructions", async () => {
      const registry = await createSkillRegistry([fromManifest([skill("alpha", { instructions: "Do the alpha thing." })])]);
      const tools = registry.tools();
      const ctx = { toolCallId: "c1", requestId: "r1", messages: [], signal: new AbortController().signal };
      const result = await tools.activate_skill!.execute!({ name: "alpha" }, ctx);
      expect(result).toBe("Do the alpha thing.");
    });

    it("activate_skill returns an error value listing valid names for an unknown skill", async () => {
      const registry = await createSkillRegistry([fromManifest([skill("alpha"), skill("beta")])]);
      const tools = registry.tools();
      const ctx = { toolCallId: "c1", requestId: "r1", messages: [], signal: new AbortController().signal };
      const result = (await tools.activate_skill!.execute!({ name: "nope" }, ctx)) as {
        error: { name: string; message: string };
      };
      expect(result.error).toBeDefined();
      expect(result.error.message).toMatch(/alpha/);
      expect(result.error.message).toMatch(/beta/);
    });

    it("read_skill_resource returns a text resource via { name, path }", async () => {
      const registry = await createSkillRegistry([
        fromManifest([
          skill("alpha", { resources: { "notes.txt": { content: "hello notes", encoding: "utf8" } } }),
        ]),
      ]);
      const tools = registry.tools();
      const ctx = { toolCallId: "c1", requestId: "r1", messages: [], signal: new AbortController().signal };
      const result = await tools.read_skill_resource!.execute!({ name: "alpha", path: "notes.txt" }, ctx);
      expect(result).toEqual({ content: "hello notes", encoding: "utf8" });
    });

    it("read_skill_resource accepts a qualified skillname/path form", async () => {
      const registry = await createSkillRegistry([
        fromManifest([
          skill("alpha", { resources: { "notes.txt": { content: "hello notes", encoding: "utf8" } } }),
        ]),
      ]);
      const tools = registry.tools();
      const ctx = { toolCallId: "c1", requestId: "r1", messages: [], signal: new AbortController().signal };
      const result = await tools.read_skill_resource!.execute!({ path: "alpha/notes.txt" }, ctx);
      expect(result).toEqual({ content: "hello notes", encoding: "utf8" });
    });

    it("read_skill_resource notes binary encoding and media type", async () => {
      const registry = await createSkillRegistry([
        fromManifest([
          skill("alpha", {
            resources: { "img.png": { content: "aGVsbG8=", encoding: "base64", mediaType: "image/png" } },
          }),
        ]),
      ]);
      const tools = registry.tools();
      const ctx = { toolCallId: "c1", requestId: "r1", messages: [], signal: new AbortController().signal };
      const result = await tools.read_skill_resource!.execute!({ name: "alpha", path: "img.png" }, ctx);
      expect(result).toEqual({ content: "aGVsbG8=", encoding: "base64", mediaType: "image/png" });
    });

    it("read_skill_resource returns an error value for an unknown skill or path", async () => {
      const registry = await createSkillRegistry([fromManifest([skill("alpha")])]);
      const tools = registry.tools();
      const ctx = { toolCallId: "c1", requestId: "r1", messages: [], signal: new AbortController().signal };
      const badSkill = (await tools.read_skill_resource!.execute!({ name: "nope", path: "x.txt" }, ctx)) as {
        error: { message: string };
      };
      expect(badSkill.error).toBeDefined();

      const badPath = (await tools.read_skill_resource!.execute!({ name: "alpha", path: "x.txt" }, ctx)) as {
        error: { message: string };
      };
      expect(badPath.error).toBeDefined();
    });
  });
});

describe("fromWorkspace", () => {
  function setup() {
    const store = createMemoryKeyValueStore();
    const ws = createWorkspace({ store, clock: systemClock });
    return ws;
  }

  it("discovers skills and their sibling resources under a prefix", async () => {
    const ws = setup();
    ws.write(
      "skills/alpha/SKILL.md",
      "---\nname: alpha\ndescription: the alpha skill\n---\nAlpha instructions body."
    );
    ws.write("skills/alpha/reference.md", "reference content");
    ws.write("skills/alpha/data/table.csv", "a,b\n1,2");
    ws.write("skills/beta/SKILL.md", "---\nname: beta\ndescription: the beta skill\n---\nBeta body.");

    const source = fromWorkspace(ws, "skills");
    const defs = await source.list();
    const byName = new Map(defs.map((d) => [d.name, d]));

    expect([...byName.keys()].sort()).toEqual(["alpha", "beta"]);

    const alpha = byName.get("alpha")!;
    expect(alpha.description).toBe("the alpha skill");
    expect(alpha.instructions).toBe("Alpha instructions body.");
    expect(alpha.resources["reference.md"]).toEqual({ content: "reference content", encoding: "utf8", mediaType: undefined });
    expect(alpha.resources["data/table.csv"]).toEqual({ content: "a,b\n1,2", encoding: "utf8", mediaType: undefined });
    expect(alpha.resources["SKILL.md"]).toBeUndefined();

    const beta = byName.get("beta")!;
    expect(beta.instructions).toBe("Beta body.");
    expect(Object.keys(beta.resources)).toEqual([]);
  });

  it("falls back to the directory name when frontmatter has no name", async () => {
    const ws = setup();
    ws.write("skills/gamma/SKILL.md", "No frontmatter here, just instructions.");
    const defs = await fromWorkspace(ws, "skills").list();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("gamma");
    expect(defs[0]?.description).toBe("");
  });

  it("defaults the prefix to 'skills'", async () => {
    const ws = setup();
    ws.write("skills/delta/SKILL.md", "---\nname: delta\ndescription: d\n---\nBody");
    const defs = await fromWorkspace(ws).list();
    expect(defs.map((d) => d.name)).toEqual(["delta"]);
  });

  it("works end-to-end through createSkillRegistry", async () => {
    const ws = setup();
    ws.write("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: the alpha skill\n---\nBody.");
    const registry = await createSkillRegistry([fromWorkspace(ws)]);
    expect(registry.get("alpha")?.description).toBe("the alpha skill");
  });
});
