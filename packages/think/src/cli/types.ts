import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyUserBindingNames,
  readProjectFiles,
  readWranglerConfig,
  resolveThinkManifest
} from "../framework/project";
import {
  generateThinkTypes,
  isThinkGeneratedFile,
  type ThinkGeneratedFile
} from "../framework/types-codegen";

export interface TypesCommandOptions {
  root?: string;
  typesFile?: string;
  wranglerEnvFile?: string;
  routePrefix?: string;
  all?: boolean;
  dryRun?: boolean;
  check?: boolean;
  wranglerArgs?: string[];
}

export async function typesCommand(
  options: TypesCommandOptions
): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd());
  const typesFile = normalizePath(options.typesFile ?? "think.d.ts");
  const wranglerEnvFile = normalizePath(options.wranglerEnvFile ?? "env.d.ts");

  const files = await readProjectFiles(root, "agents");
  const manifest = await resolveThinkManifest(
    {
      files,
      routePrefix: options.routePrefix
    },
    root
  );
  const wranglerConfig = await readWranglerConfig(root);
  if (wranglerConfig.config) {
    applyUserBindingNames(manifest, wranglerConfig.config);
  }

  if (options.all && !options.dryRun && !options.check) {
    await runWranglerTypes(root, wranglerEnvFile, options.wranglerArgs ?? []);
  }

  const generated = generateThinkTypes(manifest, {
    files,
    typesFile
  });

  if (options.dryRun) {
    console.log(
      [
        "Think types would update:",
        ...generated.map((file) => `- ${file.path}`)
      ].join("\n")
    );
    return;
  }

  if (options.check) {
    const stale = await findStaleFiles(root, generated);
    if (stale.length > 0) {
      throw new Error(
        [
          "Think generated types are out of date.",
          "Run `think types` to update:",
          ...stale.map((file) => `- ${file}`)
        ].join("\n")
      );
    }
    console.log("Think generated types are up to date.");
    return;
  }

  for (const file of generated) {
    await writeGeneratedFile(root, file);
  }

  console.log(
    [
      "Generated Think types:",
      ...generated.map((file) => `- ${file.path}`)
    ].join("\n")
  );
}

async function findStaleFiles(
  root: string,
  files: ThinkGeneratedFile[]
): Promise<string[]> {
  const stale: string[] = [];
  for (const file of files) {
    const expected = await expectedFileContent(root, file);
    const current = await readTextIfExists(path.join(root, file.path));
    if (current !== expected) stale.push(file.path);
  }
  return stale;
}

async function writeGeneratedFile(
  root: string,
  file: ThinkGeneratedFile
): Promise<void> {
  const absolute = path.join(root, file.path);
  const expected = await expectedFileContent(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, expected, "utf8");
}

async function expectedFileContent(
  root: string,
  file: ThinkGeneratedFile
): Promise<string> {
  const current = await readTextIfExists(path.join(root, file.path));
  if (current && !isThinkGeneratedFile(current)) {
    throw new Error(
      `${file.path} already exists and is not Think-generated; pass a different output path or replace it with a Think-generated file.`
    );
  }
  return file.content;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function runWranglerTypes(
  root: string,
  envFile: string,
  passthroughArgs: string[]
): Promise<void> {
  const command = await resolveWranglerCommand(root);
  const args = [
    "types",
    envFile,
    ...defaultWranglerTypeArgs(passthroughArgs),
    ...passthroughArgs
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit"
    });
    child.on("error", (error) => {
      reject(
        new Error(
          `Could not run Wrangler to generate platform types. Install wrangler in this project, or run \`think types\` without --all to generate only Think declarations.\n\n${error.message}`
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Wrangler type generation failed with exit code ${code ?? "unknown"}. Fix the Wrangler error above, or run \`think types\` without --all if you intentionally want only Think declarations.`
        )
      );
    });
  });
}

function defaultWranglerTypeArgs(args: string[]): string[] {
  return args.some(
    (arg) => arg === "--include-runtime" || arg.startsWith("--include-runtime=")
  )
    ? []
    : ["--include-runtime", "false"];
}

async function resolveWranglerCommand(root: string): Promise<string> {
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const local = path.join(root, "node_modules", ".bin", executable);
  try {
    await access(local);
    return local;
  } catch {
    return executable;
  }
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
