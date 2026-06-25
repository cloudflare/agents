import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand, type InitCommandOptions } from "../init";
import { resolveTemplateName, THINK_TEMPLATES } from "../templates";

/**
 * A stand-in for the remote (degit) fetcher: writes a minimal template that
 * mimics the `workspace:*` deps and shared Worker name a real starter ships
 * with, so `finalizeTemplate` has something to rewrite.
 */
const writeFakeTemplate: NonNullable<
  InitCommandOptions["fetchTemplate"]
> = async ({ dest }) => {
  await mkdir(dest, { recursive: true });
  await writeFile(
    path.join(dest, "package.json"),
    JSON.stringify({
      name: "think-basic-starter",
      dependencies: { "@cloudflare/think": "workspace:*" }
    }),
    "utf8"
  );
  await writeFile(
    path.join(dest, "wrangler.jsonc"),
    '{\n  "name": "think-basic-starter"\n}\n',
    "utf8"
  );
};

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "create-think-"));
}

/**
 * `templatesDir` is pointed at an empty directory so the local-template branch
 * never matches and the injected `fetchTemplate` is used instead — no network.
 */
async function baseOptions(root: string): Promise<InitCommandOptions> {
  const templatesDir = await mkdtemp(path.join(tmpdir(), "create-think-tpl-"));
  return {
    root,
    install: false,
    templatesDir,
    fetchTemplate: writeFakeTemplate,
    promptTemplate: async () => "basic",
    gitRunner: async () => {},
    isInsideGitRepo: async () => false
  };
}

describe("create-think initCommand", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the default template and rejects unknown ones", () => {
    expect(resolveTemplateName(undefined)).toBe("basic");
    expect(resolveTemplateName("basic")).toBe("basic");
    expect(() => resolveTemplateName("nope")).toThrow("Unknown template");
  });

  it("scaffolds via the injected fetcher and finalizes name + versions", async () => {
    const root = await makeRoot();
    await initCommand({
      ...(await baseOptions(root)),
      directory: "app"
    });

    const pkg = JSON.parse(
      await readFile(path.join(root, "app/package.json"), "utf8")
    ) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("app");
    // workspace:* is rewritten so the standalone project installs from npm.
    expect(pkg.dependencies["@cloudflare/think"]).toBe("latest");
    // The Worker name is updated away from the shared template name.
    expect(
      await readFile(path.join(root, "app/wrangler.jsonc"), "utf8")
    ).toContain('"name": "app"');
  });

  it("prompts for a template when none is provided", async () => {
    const root = await makeRoot();
    const selectedDefaults: string[] = [];
    const calls: Array<{ template: string; ref: string }> = [];

    await initCommand({
      ...(await baseOptions(root)),
      directory: "app",
      promptTemplate: async (defaultTemplate) => {
        selectedDefaults.push(defaultTemplate);
        return "coding-agent";
      },
      fetchTemplate: async ({ template, ref, dest }) => {
        calls.push({ template, ref });
        await writeFakeTemplate({ template, ref, dest });
      }
    });

    expect(selectedDefaults).toEqual(["basic"]);
    expect(calls).toEqual([{ template: "coding-agent", ref: "main" }]);
  });

  it("keeps the default template in --yes mode without prompting", async () => {
    const root = await makeRoot();
    const calls: Array<{ template: string; ref: string }> = [];

    await initCommand({
      ...(await baseOptions(root)),
      directory: "app",
      yes: true,
      promptTemplate: async () => {
        throw new Error("should not prompt");
      },
      fetchTemplate: async ({ template, ref, dest }) => {
        calls.push({ template, ref });
        await writeFakeTemplate({ template, ref, dest });
      }
    });

    expect(calls).toEqual([{ template: "basic", ref: "main" }]);
  });

  it("initializes git after scaffolding", async () => {
    const root = await makeRoot();
    const gitRoots: string[] = [];

    await initCommand({
      ...(await baseOptions(root)),
      directory: "app",
      gitRunner: async (gitRoot) => {
        gitRoots.push(gitRoot);
      }
    });

    expect(gitRoots).toEqual([path.join(root, "app")]);
  });

  it("skips git init when scaffolding inside an existing repository", async () => {
    const root = await makeRoot();
    let gitInitCalled = false;

    await initCommand({
      ...(await baseOptions(root)),
      directory: "app",
      isInsideGitRepo: async () => true,
      gitRunner: async () => {
        gitInitCalled = true;
      }
    });

    expect(gitInitCalled).toBe(false);
  });

  it("falls back to the default template when stdin is non-interactive", async () => {
    const root = await makeRoot();
    const calls: Array<{ template: string }> = [];
    const options = await baseOptions(root);
    // No promptTemplate and a non-TTY stdin (vitest): selection must not block.
    delete options.promptTemplate;

    await initCommand({
      ...options,
      directory: "app",
      fetchTemplate: async ({ template, ref, dest }) => {
        calls.push({ template });
        await writeFakeTemplate({ template, ref, dest });
      }
    });

    expect(calls).toEqual([{ template: "basic" }]);
  });

  it("continues when git init fails", async () => {
    const root = await makeRoot();
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(" "));
    });

    await initCommand({
      ...(await baseOptions(root)),
      directory: "app",
      gitRunner: async () => {
        throw new Error("git missing");
      }
    });

    expect(
      await readFile(path.join(root, "app/package.json"), "utf8")
    ).toContain('"name": "app"');
    expect(warnings.join("\n")).toContain("git missing");
  });

  it("defaults the interactive prompt to '.' in an empty folder", async () => {
    const root = await makeRoot();
    const offered: string[] = [];

    await initCommand({
      ...(await baseOptions(root)),
      promptTargetDirectory: async (defaultDirectory) => {
        offered.push(defaultDirectory);
        return ""; // user accepts the default
      }
    });

    expect(offered).toEqual(["."]);
    // Scaffolded in place rather than into a subfolder.
    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain(
      '"name"'
    );
  });

  it("defaults the interactive prompt to a new subfolder when not empty", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "README.md"), "hello\n", "utf8");
    const offered: string[] = [];

    await initCommand({
      ...(await baseOptions(root)),
      promptTargetDirectory: async (defaultDirectory) => {
        offered.push(defaultDirectory);
        return defaultDirectory;
      }
    });

    expect(offered[0]).toMatch(/^think-agent-/);
  });

  it("scaffolds into a fresh subfolder with --yes (never the current dir)", async () => {
    const root = await makeRoot();
    await initCommand({ ...(await baseOptions(root)), yes: true });

    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^think-agent-/);
  });

  it("refuses a non-empty target directory", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "app/existing.txt"), "keep", "utf8");

    await expect(
      initCommand({ ...(await baseOptions(root)), directory: "app" })
    ).rejects.toThrow("not empty");
  });

  it("rejects target directories outside the root", async () => {
    const root = await makeRoot();
    await expect(
      initCommand({ ...(await baseOptions(root)), directory: "../escape" })
    ).rejects.toThrow("inside the project root");
  });

  it("does not write anything in dry-run mode", async () => {
    const root = await makeRoot();
    await initCommand({
      ...(await baseOptions(root)),
      directory: "app",
      dryRun: true
    });

    await expect(readdir(path.join(root, "app"))).rejects.toThrow();
  });

  it("no-ops when the target already looks like a Think app", async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@cloudflare/think": "1.0.0" } }),
      "utf8"
    );
    await mkdir(path.join(root, "agents"), { recursive: true });
    const logs: string[] = [];
    (console.log as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (...args: unknown[]) => {
        logs.push(args.join(" "));
      }
    );

    await initCommand({ ...(await baseOptions(root)), directory: "." });

    expect(logs.join("\n")).toContain("already looks like a Think app");
  });

  it("exposes a non-empty template registry", () => {
    expect(THINK_TEMPLATES.length).toBeGreaterThan(0);
    expect(THINK_TEMPLATES[0]?.name).toBe("basic");
  });
});
