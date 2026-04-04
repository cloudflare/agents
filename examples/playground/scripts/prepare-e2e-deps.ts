import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DependencyProject = {
  workspace: string;
  dir: string;
  sentinel: string;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

const dependencyProjects: DependencyProject[] = [
  {
    workspace: "agents",
    dir: resolve(repoRoot, "packages/agents"),
    sentinel: "dist/vite.js"
  },
  {
    workspace: "@cloudflare/ai-chat",
    dir: resolve(repoRoot, "packages/ai-chat"),
    sentinel: "dist/index.js"
  },
  {
    workspace: "@cloudflare/codemode",
    dir: resolve(repoRoot, "packages/codemode"),
    sentinel: "dist/index.js"
  },
  {
    workspace: "@cloudflare/voice",
    dir: resolve(repoRoot, "packages/voice"),
    sentinel: "dist/voice.js"
  }
];

function getLatestMtime(targetPath: string): number {
  const stats = statSync(targetPath);
  if (!stats.isDirectory()) return stats.mtimeMs;

  let latest = stats.mtimeMs;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".wrangler"
    ) {
      continue;
    }
    latest = Math.max(latest, getLatestMtime(join(targetPath, entry.name)));
  }
  return latest;
}

function shouldBuild(project: DependencyProject) {
  const sentinelPath = join(project.dir, project.sentinel);
  if (!existsSync(sentinelPath)) return true;

  const outputMtime = statSync(sentinelPath).mtimeMs;
  const inputPaths = ["src", "scripts", "package.json", "tsconfig.json"]
    .map((relativePath) => join(project.dir, relativePath))
    .filter(existsSync);

  const newestInput = Math.max(
    ...inputPaths.map((path) => getLatestMtime(path))
  );
  return newestInput > outputMtime;
}

const staleProjects = dependencyProjects.filter(shouldBuild);

if (staleProjects.length === 0) {
  console.log("Playground e2e deps are up to date.");
  process.exit(0);
}

console.log(
  `Building ${staleProjects.length} stale dependency project(s): ${staleProjects
    .map((project) => project.workspace)
    .join(", ")}`
);

for (const project of staleProjects) {
  execSync(`npm run build -w ${project.workspace}`, {
    cwd: repoRoot,
    stdio: "inherit"
  });
}
