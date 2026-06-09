import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import agents from "../vite";
import { compileSkillScript, isCompilableSkillScript } from "../skills/compile";

type ResolveIdFn = (
  source: string,
  importer?: string
) => Promise<string | null>;
type LoadFn = (id: string) => Promise<string | null>;

interface PluginContext {
  warn: (message: string) => void;
  addWatchFile: (id: string) => void;
}

function pluginByName(name: string, options?: Parameters<typeof agents>[0]) {
  const plugin = agents(options).find((p) => p.name === name);
  if (!plugin) throw new Error(`plugin "${name}" not found`);
  return plugin;
}

function skillsPlugin(): Plugin {
  return pluginByName("agents-skills-import");
}

function resolveId(plugin: Plugin, ctx: PluginContext): ResolveIdFn {
  const hook = plugin.resolveId as unknown as ResolveIdFn;
  return (source, importer) => hook.call(ctx, source, importer);
}

function load(plugin: Plugin, ctx: PluginContext): LoadFn {
  const hook = plugin.load as unknown as LoadFn;
  return (id) => hook.call(ctx, id);
}

let dir: string;

async function writeSkill(
  root: string,
  name: string,
  extra?: () => Promise<void>
): Promise<void> {
  const skillDir = join(root, name);
  await mkdir(join(skillDir, "references"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n`
  );
  await writeFile(join(skillDir, "references", "guide.md"), "- be concise\n");
  await extra?.();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agents-skills-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("agents:skills vite plugin", () => {
  it("resolves the default specifier to a ./skills sibling directory", async () => {
    const plugin = skillsPlugin();
    const ctx: PluginContext = { warn: () => {}, addWatchFile: () => {} };
    const importer = join(dir, "server.ts");

    const resolved = await resolveId(plugin, ctx)("agents:skills", importer);
    expect(resolved).toBe(`\0agents:skills:${join(dir, "skills")}`);
  });

  it("resolves a named specifier to the matching sibling directory", async () => {
    const plugin = skillsPlugin();
    const ctx: PluginContext = { warn: () => {}, addWatchFile: () => {} };
    const importer = join(dir, "server.ts");

    const resolved = await resolveId(plugin, ctx)(
      "agents:skills/marketing",
      importer
    );
    expect(resolved).toBe(`\0agents:skills:${join(dir, "marketing")}`);
  });

  it("ignores unrelated specifiers", async () => {
    const plugin = skillsPlugin();
    const ctx: PluginContext = { warn: () => {}, addWatchFile: () => {} };
    const resolved = await resolveId(plugin, ctx)(
      "./skills",
      join(dir, "server.ts")
    );
    expect(resolved).toBeNull();
  });

  it("builds a SkillSource module from a skills directory", async () => {
    const skillsDir = join(dir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "release-notes");

    const plugin = skillsPlugin();
    const ctx: PluginContext = { warn: () => {}, addWatchFile: () => {} };
    const code = await load(plugin, ctx)(`\0agents:skills:${skillsDir}`);

    expect(code).toContain('"name":"release-notes"');
    expect(code).toContain('"fingerprint"');
    expect(code).toContain("export default");
  });

  it("warns on duplicate bundled skill names", async () => {
    const skillsDir = join(dir, "skills");
    await mkdir(skillsDir, { recursive: true });
    // Two directories declaring the same skill name.
    await writeSkill(skillsDir, "dir-a");
    await writeFile(
      join(skillsDir, "dir-a", "SKILL.md"),
      "---\nname: dup\ndescription: A.\n---\n\nA\n"
    );
    await mkdir(join(skillsDir, "dir-b"), { recursive: true });
    await writeFile(
      join(skillsDir, "dir-b", "SKILL.md"),
      "---\nname: dup\ndescription: B.\n---\n\nB\n"
    );

    const warnings: string[] = [];
    const plugin = skillsPlugin();
    const ctx: PluginContext = {
      warn: (message) => warnings.push(message),
      addWatchFile: () => {}
    };
    await load(plugin, ctx)(`\0agents:skills:${skillsDir}`);

    expect(warnings.join("\n")).toContain('Duplicate bundled skill name "dup"');
  });

  it("compiles TypeScript and multi-file skill scripts to self-contained JS", async () => {
    const skillsDir = join(dir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "scripted", async () => {
      const scriptsDir = join(skillsDir, "scripted", "scripts");
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(
        join(scriptsDir, "helper.ts"),
        "export function format(text: string): string {\n  return text.toUpperCase();\n}\n"
      );
      await writeFile(
        join(scriptsDir, "run.ts"),
        'import { format } from "./helper";\ntype Input = { text: string };\nexport default async function run(input: Input) {\n  return format(input.text);\n}\n'
      );
    });

    const plugin = skillsPlugin();
    const ctx: PluginContext = { warn: () => {}, addWatchFile: () => {} };
    const code = await load(plugin, ctx)(`\0agents:skills:${skillsDir}`);
    const manifest = code as string;

    // The script resource is marked precompiled, the sibling import is inlined,
    // and TypeScript type syntax has been stripped.
    expect(manifest).toContain('"precompiled":true');
    expect(manifest).not.toContain('from "./helper"');
    expect(manifest).not.toContain("type Input");
    expect(manifest).toContain("toUpperCase()");
  });

  it("warns when a bundled asset exceeds the size threshold", async () => {
    const skillsDir = join(dir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeSkill(skillsDir, "heavy", async () => {
      await mkdir(join(skillsDir, "heavy", "assets"), { recursive: true });
      await writeFile(
        join(skillsDir, "heavy", "assets", "big.bin"),
        Buffer.alloc(300 * 1024, 1)
      );
    });

    const warnings: string[] = [];
    const plugin = skillsPlugin();
    const ctx: PluginContext = {
      warn: (message) => warnings.push(message),
      addWatchFile: () => {}
    };
    await load(plugin, ctx)(`\0agents:skills:${skillsDir}`);

    const joined = warnings.join("\n");
    expect(joined).toContain("assets/big.bin");
    expect(joined).toContain("skills.r2()");
  });
});

describe("compileSkillScript", () => {
  let compileDir: string;

  beforeEach(async () => {
    compileDir = await mkdtemp(join(tmpdir(), "agents-compile-"));
  });

  afterEach(async () => {
    await rm(compileDir, { recursive: true, force: true });
  });

  it("flags compilable script extensions", () => {
    expect(isCompilableSkillScript("scripts/run.ts")).toBe(true);
    expect(isCompilableSkillScript("scripts/run.tsx")).toBe(true);
    expect(isCompilableSkillScript("scripts/run.js")).toBe(true);
    expect(isCompilableSkillScript("scripts/run.mjs")).toBe(true);
    expect(isCompilableSkillScript("scripts/run.py")).toBe(false);
    expect(isCompilableSkillScript("scripts/run.sh")).toBe(false);
    expect(isCompilableSkillScript("references/guide.md")).toBe(false);
  });

  it("bundles a TypeScript entry with sibling imports into self-contained ESM", async () => {
    await writeFile(
      join(compileDir, "helper.ts"),
      "export function shout(text: string): string {\n  return text.toUpperCase();\n}\n"
    );
    const entry = join(compileDir, "run.ts");
    await writeFile(
      entry,
      'import { shout } from "./helper";\ntype Input = { text: string };\nexport default async function run(input: Input) {\n  return shout(input.text);\n}\n'
    );

    const result = await compileSkillScript(entry);

    expect(result.precompiled).toBe(true);
    expect(result.content).not.toContain('from "./helper"');
    expect(result.content).not.toContain("type Input");
    expect(result.content).toContain("toUpperCase()");
    expect(result.content).toMatch(/as default/);
  });

  it("throws when the entry file does not exist", async () => {
    await expect(
      compileSkillScript(join(compileDir, "missing.ts"))
    ).rejects.toThrow();
  });
});

describe("turndown stub vite plugin", () => {
  const ctx: PluginContext = { warn: () => {}, addWatchFile: () => {} };

  it("is enabled by default and resolves turndown to a virtual stub", async () => {
    const plugin = pluginByName("agents-turndown-stub");
    const resolved = await resolveId(plugin, ctx)("turndown");
    expect(resolved).toBe("\0agents:turndown-stub");

    const code = await load(plugin, ctx)("\0agents:turndown-stub");
    expect(code).toContain("class TurndownService");
    expect(code).toContain("export default TurndownService");
  });

  it("ignores unrelated specifiers", async () => {
    const plugin = pluginByName("agents-turndown-stub");
    expect(await resolveId(plugin, ctx)("turndown-plugin-gfm")).toBeNull();
    expect(await load(plugin, ctx)("turndown")).toBeNull();
  });

  it("can be disabled via stubTurndown: false", () => {
    const names = agents({ stubTurndown: false }).map((p) => p.name);
    expect(names).not.toContain("agents-turndown-stub");
  });
});
