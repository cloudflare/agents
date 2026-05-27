import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../cli/create";

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

  it("shows help", async () => {
    const cli = createCli(["node", "think", "--help"]);

    await cli.exitProcess(false).parse();

    const output = [...consoleOutput, ...consoleError].join("\n");
    expect(output).toContain("inspect");
    expect(output).toContain("types");
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
