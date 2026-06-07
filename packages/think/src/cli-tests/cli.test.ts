import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../cli/create";
import { initCommand } from "../cli/init";
import { readWranglerConfig } from "../framework/project";

describe("think CLI", () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let consoleOutput: string[] = [];
  let consoleError: string[] = [];

  beforeEach(() => {
    consoleOutput = [];
    consoleError = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = vi.fn((...args) => {
      consoleOutput.push(args.map(String).join(" "));
    });
    console.error = vi.fn((...args) => {
      consoleError.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
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

  it("initializes a generated default target with --yes", async () => {
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
    expect(agentSource).toContain("createWorkersAI");
    expect(agentSource).toContain("@cf/moonshotai/kimi-k2.6");
    expect(agentSource).toContain("override getSystemPrompt()");
    expect(agentSource).toContain("override getScheduledTasks()");
    expect(agentSource).toContain("override getSkills()");
    expect(agentSource).toContain(`import bundledSkills from "agents:skills"`);
    expect(agentSource).toContain("skills.runner({");
    expect(await readFile(path.join(appRoot, "think.d.ts"), "utf8")).toContain(
      `declare module "virtual:think/entry"`
    );
    expect(
      await readFile(
        path.join(appRoot, "agents/assistant/skills/project-helper/SKILL.md"),
        "utf8"
      )
    ).toContain("Project Helper");
    // `agents:skills` ships ambient types from the `agents` package, so no
    // per-agent skills.d.ts shim is generated.
    await expect(
      readFile(path.join(appRoot, "agents/assistant/skills.d.ts"), "utf8")
    ).rejects.toThrow();
    expect(consoleOutput.join("\n")).toContain("Created Think app");
  });

  it("prompts for current-directory initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await initCommand({
      root,
      install: false,
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

  it("initializes a lightly prepared npm project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await mkdir(path.join(root, "prepared"), { recursive: true });
    await writeFile(
      path.join(root, "prepared/package.json"),
      JSON.stringify({
        name: "prepared",
        scripts: { test: "vitest" },
        dependencies: { zod: "^4.0.0" }
      }),
      "utf8"
    );

    await initCommand({
      root,
      directory: "prepared",
      install: false
    });

    const packageJson = JSON.parse(
      await readFile(path.join(root, "prepared/package.json"), "utf8")
    ) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(packageJson.name).toBe("prepared");
    expect(packageJson.scripts.test).toBe("vitest");
    expect(packageJson.scripts.dev).toBe("vite dev");
    expect(packageJson.dependencies.zod).toBe("^4.0.0");
    expect(packageJson.dependencies["@cloudflare/think"]).toBe("latest");
    expect(packageJson.dependencies["workers-ai-provider"]).toBe("latest");
  });

  it("initializes a prepared project that already has the Think dependency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await mkdir(path.join(root, "prepared"), { recursive: true });
    await writeFile(
      path.join(root, "prepared/package.json"),
      JSON.stringify({
        name: "prepared",
        dependencies: { "@cloudflare/think": "^0.7.0" }
      }),
      "utf8"
    );

    await initCommand({
      root,
      directory: "prepared",
      install: false
    });

    expect(
      await readFile(
        path.join(root, "prepared/agents/assistant/agent.ts"),
        "utf8"
      )
    ).toContain("export class Assistant");
  });

  it("rejects target directories outside the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await expect(
      initCommand({
        root,
        directory: "../outside",
        install: false
      })
    ).rejects.toThrow("inside the project root");
  });

  it("applies a custom route prefix to generated config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await initCommand({
      root,
      directory: "route-app",
      routePrefix: "/api/agents",
      install: false
    });

    expect(
      await readFile(path.join(root, "route-app/vite.config.ts"), "utf8")
    ).toContain(`routePrefix: "/api/agents"`);
    expect(
      await readFile(path.join(root, "route-app/wrangler.jsonc"), "utf8")
    ).toContain(`"/api/agents/*"`);
    expect(
      await readFile(path.join(root, "route-app/wrangler.jsonc"), "utf8")
    ).toContain(`"binding": "AI"`);
    expect(
      await readFile(path.join(root, "route-app/wrangler.jsonc"), "utf8")
    ).toContain(`"binding": "LOADER"`);
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
      install: false
    });

    expect(consoleOutput.join("\n")).toContain(
      "This already looks like a Think app."
    );
  });

  it("refuses existing non-Think Vite or Wrangler apps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(
      path.join(root, "app/vite.config.ts"),
      "export default {};",
      "utf8"
    );

    await expect(
      initCommand({
        root,
        directory: "app",
        install: false
      })
    ).rejects.toThrow("will not migrate it automatically");
  });

  it("refuses to overwrite user-owned files without partial writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    await mkdir(path.join(root, "app/agents/assistant"), { recursive: true });
    await writeFile(
      path.join(root, "app/package.json"),
      JSON.stringify({ name: "app", scripts: { test: "vitest" } }),
      "utf8"
    );
    await writeFile(
      path.join(root, "app/agents/assistant/agent.ts"),
      "export const userOwned = true;",
      "utf8"
    );

    await expect(
      initCommand({
        root,
        directory: "app",
        install: false
      })
    ).rejects.toThrow("Refusing to overwrite");

    const packageJson = JSON.parse(
      await readFile(path.join(root, "app/package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts).toEqual({ test: "vitest" });
  });

  it("prints init dry-run output without writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));

    await initCommand({
      root,
      directory: "dry-app",
      dryRun: true
    });

    expect(await readdir(root)).toEqual([]);
    const output = consoleOutput.join("\n");
    expect(output).toContain("Think init would create:");
    expect(output).toContain("package.json");
    expect(output).toContain("Would run: npm install");
  });

  it("generates an app that inspect and types check can read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "think-init-"));
    const appRoot = path.join(root, "ready-app");

    await initCommand({
      root,
      directory: "ready-app",
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
      installRunner: async (installRoot) => {
        installedRoots.push(installRoot);
      }
    });

    expect(installedRoots).toEqual([path.join(root, "install-app")]);
    expect(consoleOutput.join("\n")).toContain(
      "Edit agents/assistant/agent.ts to customize the model, prompt, skills, and schedules"
    );
  });

  it("shows help", async () => {
    const cli = createCli(["node", "think", "--help"]);

    await cli.exitProcess(false).parse();

    const output = [...consoleOutput, ...consoleError].join("\n");
    expect(output).toContain("init");
    expect(output).toContain("inspect");
    expect(output).toContain("types");
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
