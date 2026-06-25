import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THINK_TEMPLATES } from "create-think";
import { createCli } from "../cli/create";
import {
  initCommand,
  THIRD_PARTY_DEPENDENCIES,
  THIRD_PARTY_DEV_DEPENDENCIES
} from "../cli/init";
import { readWranglerConfig } from "../framework/project";

describe("think CLI", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalConsoleWarn: typeof console.warn;
  let consoleOutput: string[] = [];
  let consoleError: string[] = [];
  let consoleWarn: string[] = [];

  beforeEach(() => {
    consoleOutput = [];
    consoleError = [];
    consoleWarn = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.log = vi.fn((...args) => {
      consoleOutput.push(args.map(String).join(" "));
    });
    console.error = vi.fn((...args) => {
      consoleError.push(args.map(String).join(" "));
    });
    console.warn = vi.fn((...args) => {
      consoleWarn.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  it("prints inspect output for a Think project", async () => {
    const root = await createFixture();
    const cli = createCli(["node", "think", "inspect", "--root", root]);

    await cli.exitProcess(false).parse();

    const output = consoleOutput.join("\n");
    expect(output).toContain("Think inspect");
    expect(output).toContain("host | class ThinkAgent_Host");
    expect(output).toContain("Route prefix: /agents");
  });

  it("prints deterministic inspect facts for features and route surfaces", async () => {
    const root = await createFixture();
    await mkdir(path.join(root, "agents/host/skills/review"), {
      recursive: true
    });
    await writeFile(
      path.join(root, "agents/host/skills/review/SKILL.md"),
      "# Review",
      "utf8"
    );
    const cli = createCli(["node", "think", "inspect", "--root", root]);

    await cli.exitProcess(false).parse();

    const output = consoleOutput.join("\n");
    expect(output).toContain("Route surfaces:");
    expect(output).toContain("agent:host");
    expect(output).toContain("features skills");
    expect(output).toContain("Messengers:\n- none");
    expect(output).toContain("Platform requirements:");
    expect(output).toContain("worker_loader LOADER");
  });

  it("prints inspect JSON output", async () => {
    const root = await createFixture();
    const cli = createCli([
      "node",
      "think",
      "inspect",
      "--root",
      root,
      "--json"
    ]);

    await cli.exitProcess(false).parse();

    const parsed = JSON.parse(consoleOutput.join("\n")) as {
      manifest: { agents: Array<{ id: string }> };
    };
    expect(parsed.manifest.agents[0]?.id).toBe("host");
  });

  it("generates Think-only types", async () => {
    const root = await createFixture();
    const cli = createCli(["node", "think", "types", "--root", root]);

    await cli.exitProcess(false).parse();

    const types = await readFile(path.join(root, "think.d.ts"), "utf8");
    expect(types).toContain(`declare module "virtual:think/entry"`);
    expect(types).toContain("DurableObjectNamespace");
    expect(consoleOutput.join("\n")).toContain("Generated Think types:");
  });

  it("uses binding names from wrangler.toml in generated types", async () => {
    const root = await createFixture({ config: "toml" });
    const cli = createCli(["node", "think", "types", "--root", root]);

    await cli.exitProcess(false).parse();

    const types = await readFile(path.join(root, "think.d.ts"), "utf8");
    expect(types).toContain("HostToml");
    expect(types).toContain("ThinkAgent_Host");
  });

  it("runs Wrangler type generation only with --all", async () => {
    const root = await createFixture();
    await installWranglerRecorder(root);
    const cli = createCli(["node", "think", "types", "--root", root, "--all"]);

    await cli.exitProcess(false).parse();

    const args = await readFile(path.join(root, "wrangler-args.json"), "utf8");
    expect(JSON.parse(args)).toEqual([
      "types",
      "env.d.ts",
      "--include-runtime",
      "false"
    ]);
  });

  it("passes through Wrangler type flags after --", async () => {
    const root = await createFixture();
    await installWranglerRecorder(root);
    const cli = createCli([
      "node",
      "think",
      "types",
      "--root",
      root,
      "--all",
      "--",
      "--env",
      "production",
      "--include-runtime",
      "true"
    ]);

    await cli.exitProcess(false).parse();

    const args = await readFile(path.join(root, "wrangler-args.json"), "utf8");
    expect(JSON.parse(args)).toEqual([
      "types",
      "env.d.ts",
      "--env",
      "production",
      "--include-runtime",
      "true"
    ]);
  });

  it("does not add the default runtime flag when passed as an assignment", async () => {
    const root = await createFixture();
    await installWranglerRecorder(root);
    const cli = createCli([
      "node",
      "think",
      "types",
      "--root",
      root,
      "--all",
      "--",
      "--include-runtime=true"
    ]);

    await cli.exitProcess(false).parse();

    const args = await readFile(path.join(root, "wrangler-args.json"), "utf8");
    expect(JSON.parse(args)).toEqual([
      "types",
      "env.d.ts",
      "--include-runtime=true"
    ]);
  });

  it("runs Wrangler type generation with --all even without config", async () => {
    const root = await createFixture({ config: "none" });
    await installWranglerRecorder(root);
    const cli = createCli(["node", "think", "types", "--root", root, "--all"]);

    await cli.exitProcess(false).parse();

    const args = await readFile(path.join(root, "wrangler-args.json"), "utf8");
    expect(JSON.parse(args)).toEqual([
      "types",
      "env.d.ts",
      "--include-runtime",
      "false"
    ]);
  });

  it("checks stale generated types without writing", async () => {
    const root = await createFixture();
    const cli = createCli([
      "node",
      "think",
      "types",
      "--root",
      root,
      "--check"
    ]);

    await expect(cli.exitProcess(false).parse()).rejects.toThrow(
      "Think generated types are out of date"
    );
  });

  it("rejects existing non-generated Think type files", async () => {
    const root = await createFixture();
    await writeFile(
      path.join(root, "think.d.ts"),
      "declare const userOwned: true;\n",
      "utf8"
    );
    const cli = createCli(["node", "think", "types", "--root", root]);

    await expect(cli.exitProcess(false).parse()).rejects.toThrow(
      "think.d.ts already exists"
    );
  });

  it("scaffolds the default (basic) template with --yes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    const cli = createCli([
      "node",
      "think",
      "init",
      "--root",
      root,
      "--yes",
      "--no-install"
    ]);

    await cli.exitProcess(false).parse();

    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^think-agent-/);
    const appRoot = path.join(root, entries[0] ?? "");
    const agentSource = await readFile(
      path.join(appRoot, "agents/assistant/agent.ts"),
      "utf8"
    );
    expect(agentSource).toContain("export class Assistant");
    expect(agentSource).toContain("@cf/moonshotai/kimi-k2.7-code");
    expect(await readFile(path.join(appRoot, "think.d.ts"), "utf8")).toContain(
      `declare module "virtual:think/entry"`
    );
    expect(
      await readFile(path.join(appRoot, "wrangler.jsonc"), "utf8")
    ).toContain("virtual:think/entry");
    expect(consoleOutput.join("\n")).toContain('Created a "basic" Think app');
  });

  it("scaffolds every known template and rewrites workspace versions", async () => {
    for (const { name } of THINK_TEMPLATES) {
      const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
      await initCommand({
        root,
        directory: "app",
        template: name,
        install: false
      });
      const appRoot = path.join(root, "app");
      const pkg = JSON.parse(
        await readFile(path.join(appRoot, "package.json"), "utf8")
      ) as { name: string; dependencies: Record<string, string> };
      expect(pkg.name).toBe("app");
      // `workspace:*` deps are rewritten to a published range for end users.
      for (const version of Object.values(pkg.dependencies)) {
        expect(version.startsWith("workspace:")).toBe(false);
      }
      const wrangler = await readFile(
        path.join(appRoot, "wrangler.jsonc"),
        "utf8"
      );
      expect(wrangler).toContain("virtual:think/entry");
      // The Worker name is updated so each scaffolded app deploys under its own
      // name rather than the shared template name.
      expect(wrangler).toContain(`"name": "app"`);
      expect(wrangler).not.toContain(`${name}-starter`);
    }
  });

  it("rejects unknown templates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await expect(
      initCommand({
        root,
        directory: "app",
        template: "does-not-exist",
        install: false
      })
    ).rejects.toThrow("Unknown template");
  });

  it("uses the injected fetchTemplate when no local template exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    const emptyTemplates = await mkdtemp(path.join(tmpdir(), "think-tpl-"));
    const calls: Array<{ template: string; ref: string }> = [];

    await initCommand({
      root,
      directory: "remote-app",
      install: false,
      promptTemplate: async () => "basic",
      templatesDir: emptyTemplates,
      fetchTemplate: async ({ template, ref, dest }) => {
        calls.push({ template, ref });
        await mkdir(dest, { recursive: true });
        await writeFile(
          path.join(dest, "package.json"),
          JSON.stringify({
            name: "placeholder",
            dependencies: { "@cloudflare/think": "workspace:*" }
          }),
          "utf8"
        );
      }
    });

    expect(calls).toEqual([{ template: "basic", ref: "main" }]);
    const pkg = JSON.parse(
      await readFile(path.join(root, "remote-app/package.json"), "utf8")
    ) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("remote-app");
    expect(pkg.dependencies["@cloudflare/think"]).toBe("latest");
  });

  it("prompts for current-directory initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await initCommand({
      root,
      install: false,
      promptTemplate: async () => "basic",
      promptTargetDirectory: async () => "."
    });

    expect(await readFile(path.join(root, "package.json"), "utf8")).toContain(
      `"@cloudflare/think"`
    );
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toContain(
      "think()"
    );
  });

  it("initializes a named target directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    const cli = createCli([
      "node",
      "think",
      "init",
      "my-app",
      "--root",
      root,
      "--template",
      "basic",
      "--no-install"
    ]);

    await cli.exitProcess(false).parse();

    const packageJson = JSON.parse(
      await readFile(path.join(root, "my-app/package.json"), "utf8")
    ) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(packageJson.name).toBe("my-app");
    expect(packageJson.scripts.dev).toBe("vite dev");
  });

  it("refuses a non-empty target directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "app/existing.txt"), "hello", "utf8");

    await expect(
      initCommand({
        root,
        directory: "app",
        template: "basic",
        install: false
      })
    ).rejects.toThrow("not empty");
  });

  it("rejects target directories outside the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await expect(
      initCommand({
        root,
        directory: "../outside",
        template: "basic",
        install: false
      })
    ).rejects.toThrow("inside the project root");
  });

  it("no-ops for existing Think apps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await mkdir(path.join(root, "app/agents/assistant"), { recursive: true });
    await writeFile(
      path.join(root, "app/package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { "@cloudflare/think": "latest" }
      }),
      "utf8"
    );

    await initCommand({
      root,
      directory: "app",
      template: "basic",
      install: false
    });

    expect(consoleOutput.join("\n")).toContain(
      "This already looks like a Think app."
    );
  });

  it("prints init dry-run output without writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await initCommand({
      root,
      directory: "dry-app",
      promptTemplate: async () => "basic",
      dryRun: true
    });

    expect(await readdir(root)).toEqual([]);
    const output = consoleOutput.join("\n");
    expect(output).toContain('would create a "basic" app');
    expect(output).toContain("Would run: npm install");
  });

  it("generates an app that inspect and types check can read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    const appRoot = path.join(root, "ready-app");

    await initCommand({
      root,
      directory: "ready-app",
      promptTemplate: async () => "basic",
      install: false
    });

    const inspectCli = createCli([
      "node",
      "think",
      "inspect",
      "--root",
      appRoot
    ]);
    await inspectCli.exitProcess(false).parse();
    expect(consoleOutput.join("\n")).toContain(
      "assistant | class ThinkAgent_Assistant"
    );

    const typesCli = createCli([
      "node",
      "think",
      "types",
      "--root",
      appRoot,
      "--check"
    ]);
    await typesCli.exitProcess(false).parse();
    expect(consoleOutput.join("\n")).toContain(
      "Think generated types are up to date."
    );
  });

  it("runs installer through an injectable runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    const installedRoots: string[] = [];

    await initCommand({
      root,
      directory: "install-app",
      promptTemplate: async () => "basic",
      installRunner: async (installRoot) => {
        installedRoots.push(installRoot);
      }
    });

    expect(installedRoots).toEqual([path.join(root, "install-app")]);
    expect(consoleOutput.join("\n")).toContain(
      "Edit the agent in agents/ to customize the model, prompt, tools, and skills"
    );
  });

  it("augments an existing project in place instead of fetching a template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "existing-app",
        dependencies: { "some-dep": "^1.0.0" }
      }),
      "utf8"
    );

    await initCommand({ root, install: false });

    // Adds Think framework files to the current directory (no subfolder).
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toContain(
      "think()"
    );
    expect(await readFile(path.join(root, "wrangler.jsonc"), "utf8")).toContain(
      "virtual:think/entry"
    );
    expect(
      await readFile(path.join(root, "agents/assistant/agent.ts"), "utf8")
    ).toContain("export class Assistant");
    // Merges into the existing package.json, keeping the user's name and deps.
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8")
    ) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("existing-app");
    expect(pkg.dependencies["some-dep"]).toBe("^1.0.0");
    expect(pkg.dependencies["@cloudflare/think"]).toBe("latest");
    expect(consoleOutput.join("\n")).toContain("Added Think to");
  });

  it("initializes git when augmenting an existing project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );
    const gitRoots: string[] = [];

    await initCommand({
      root,
      install: false,
      isInsideGitRepo: async () => false,
      gitRunner: async (gitRoot) => {
        gitRoots.push(gitRoot);
      }
    });

    expect(gitRoots).toEqual([root]);
    expect(consoleOutput.join("\n")).toContain("Initialized a git repository.");
  });

  it("skips git init when already inside a git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );
    let gitInitCalled = false;

    await initCommand({
      root,
      install: false,
      isInsideGitRepo: async () => true,
      gitRunner: async () => {
        gitInitCalled = true;
      }
    });

    expect(gitInitCalled).toBe(false);
    expect(consoleOutput.join("\n")).toContain(
      "Already inside a git repository"
    );
  });

  it("continues augmenting when git init fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );

    await initCommand({
      root,
      install: false,
      isInsideGitRepo: async () => false,
      gitRunner: async () => {
        throw new Error("git missing");
      }
    });

    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toContain(
      "think()"
    );
    expect(consoleOutput.join("\n")).toContain("Skipped git init.");
    expect(consoleWarn.join("\n")).toContain("git missing");
  });

  it("fetches a template even inside an existing project when --template is set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );

    await initCommand({
      root,
      template: "basic",
      directory: "app",
      install: false
    });

    // Template scaffold (not augment): a full starter app in the subfolder.
    expect(
      await readFile(path.join(root, "app/package.json"), "utf8")
    ).toContain("@cloudflare/kumo");
    // The existing project's package.json is left untouched.
    const outer = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(outer.dependencies).toBeUndefined();
  });

  it("refuses to augment a project that already has Vite config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );
    await writeFile(
      path.join(root, "vite.config.ts"),
      "export default {};\n",
      "utf8"
    );

    await expect(initCommand({ root, install: false })).rejects.toThrow(
      "will not migrate it automatically"
    );
  });

  it("prints augment dry-run output without writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );

    await initCommand({ root, dryRun: true });

    expect(consoleOutput.join("\n")).toContain(
      "Think init would add to the current project:"
    );
    expect(consoleOutput.join("\n")).toContain(
      "Would initialize a git repository"
    );
    await expect(
      readFile(path.join(root, "vite.config.ts"), "utf8")
    ).rejects.toThrow();
  });

  it("keeps an existing tsconfig.json when augmenting instead of aborting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app" }),
      "utf8"
    );
    const userTsconfig = JSON.stringify({ compilerOptions: { strict: true } });
    await writeFile(path.join(root, "tsconfig.json"), userTsconfig, "utf8");

    await initCommand({ root, install: false });

    // The user's tsconfig is left untouched, and Think files are still written.
    expect(await readFile(path.join(root, "tsconfig.json"), "utf8")).toBe(
      userTsconfig
    );
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toContain(
      "think()"
    );
    expect(consoleOutput.join("\n")).toContain(
      "Kept your existing files (not overwritten):"
    );
    expect(consoleOutput.join("\n")).toContain("- tsconfig.json");
  });

  it("forces type:module when augmenting a CommonJS project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "existing-app", type: "commonjs" }),
      "utf8"
    );

    await initCommand({ root, install: false });

    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8")
    ) as { type: string };
    expect(pkg.type).toBe("module");
  });

  it("pins augment third-party deps to the basic starter's ranges", () => {
    // Single source of truth for tested third-party versions is the starter
    // template. If anyone bumps the starter (or the augment generator) without
    // updating the other, this fails so the two can't silently drift apart.
    const starterPath = fileURLToPath(
      new URL("../../../../think-starters/basic/package.json", import.meta.url)
    );
    const starter = JSON.parse(readFileSync(starterPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const starterRanges = {
      ...starter.dependencies,
      ...starter.devDependencies
    };

    for (const [name, range] of Object.entries({
      ...THIRD_PARTY_DEPENDENCIES,
      ...THIRD_PARTY_DEV_DEPENDENCIES
    })) {
      expect(
        starterRanges[name],
        `${name} must match think-starters/basic/package.json`
      ).toBe(range);
    }
  });

  it("shows help", async () => {
    const cli = createCli(["node", "think", "--help"]);

    await cli.exitProcess(false).parse();

    const output = [...consoleOutput, ...consoleError].join("\n");
    expect(output).toContain("init");
    expect(output).toContain("inspect");
    expect(output).toContain("types");
    expect(output).toContain("studio");
    expect(output).toContain("state");
  });

  it("documents studio connection flags", async () => {
    const cli = createCli(["node", "think", "studio", "--help"]);

    await cli.exitProcess(false).parse();

    const output = [...consoleOutput, ...consoleError].join("\n");
    expect(output).toContain("--url");
    expect(output).toContain("--token");
    expect(output).toContain("--route-prefix");
    expect(output).toContain("--port");
  });
});

describe("readWranglerConfig (TOML)", () => {
  it("parses inline tables inside arrays and array-of-tables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-toml-"));
    await writeFile(
      path.join(root, "wrangler.toml"),
      [
        'main = "virtual:think/entry"',
        // Inline table inside an array — the kind of value a naive
        // comma-splitting parser mishandles.
        'kv_namespaces = [{ binding = "CACHE", id = "cache-id" }]',
        "",
        "[[durable_objects.bindings]]",
        'name = "Host"',
        'class_name = "ThinkAgent_Host"',
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await readWranglerConfig(root);

    expect(result.error).toBeUndefined();
    expect(result.path).toBe("wrangler.toml");
    const config = result.config as {
      kv_namespaces: Array<{ binding: string; id: string }>;
      durable_objects: { bindings: Array<{ class_name: string }> };
    };
    expect(config.kv_namespaces).toEqual([
      { binding: "CACHE", id: "cache-id" }
    ]);
    expect(config.durable_objects.bindings[0]?.class_name).toBe(
      "ThinkAgent_Host"
    );
  });

  it("reports a recoverable error for invalid TOML instead of throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-toml-bad-"));
    await writeFile(
      path.join(root, "wrangler.toml"),
      'main = "virtual:think/entry"\n[unclosed\n',
      "utf8"
    );

    const result = await readWranglerConfig(root);

    expect(result.config).toBeNull();
    expect(result.path).toBe("wrangler.toml");
    expect(result.error).toContain("Could not parse wrangler.toml");
  });
});

async function createFixture(
  options: { config?: "jsonc" | "toml" | "none" } = {}
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "think-cli-"));
  await mkdir(path.join(root, "agents"), { recursive: true });
  await writeFile(
    path.join(root, "agents/host.ts"),
    `
      import { Agent } from "agents";
      export class HostAgent extends Agent<Env> {}
    `,
    "utf8"
  );
  if ((options.config ?? "jsonc") === "jsonc") {
    await writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        main: "virtual:think/entry",
        durable_objects: {
          bindings: [{ name: "Host", class_name: "ThinkAgent_Host" }]
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["ThinkAgent_Host"] }]
      }),
      "utf8"
    );
  }
  if (options.config === "toml") {
    await writeFile(
      path.join(root, "wrangler.toml"),
      [
        'main = "virtual:think/entry"',
        'kv_namespaces = [{ binding = "CACHE", id = "cache-id" }]',
        "",
        "[[durable_objects.bindings]]",
        'name = "HostToml"',
        'class_name = "ThinkAgent_Host"',
        "",
        "[[migrations]]",
        'tag = "v1"',
        'new_sqlite_classes = ["ThinkAgent_Host"]',
        ""
      ].join("\n"),
      "utf8"
    );
  }
  return root;
}

async function installWranglerRecorder(root: string): Promise<void> {
  const bin = path.join(root, "node_modules/.bin");
  await mkdir(bin, { recursive: true });
  const executable = path.join(
    bin,
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      'writeFileSync(join(process.cwd(), "wrangler-args.json"), JSON.stringify(process.argv.slice(2)));',
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(executable, 0o755);
}
