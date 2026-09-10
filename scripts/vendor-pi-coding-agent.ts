/**
 * Vendors pi's extension runtime into
 * examples/next/harnesses/pi/vendor/pi-coding-agent-src/.
 *
 * The pi coding agent cannot be bundled for workerd, but its extension runtime
 * is portable. This script copies a small set of files verbatim from a pinned
 * upstream commit, applies the patches in `patches/`, and writes MANIFEST.json.
 * Hand-written stubs live at the upstream relative paths next to the copied
 * files; they are NOT generated here (see the vendor README).
 *
 * Usage:
 *   pnpm vendor:pi          regenerate the vendored files in place
 *   pnpm vendor:pi:check    regenerate into a temp dir and fail on drift
 *
 * Source repository: PI_REPO env var, or ~/Documents/Github/pi-mono when it
 * exists, otherwise a shallow clone into a temp dir.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Pinned upstream commit. Bump deliberately, then re-run and re-typecheck. */
const UPSTREAM_COMMIT = "c4b0e35abe631bc830190fa6cafbe81b098b97d7";
/** Version of the @earendil-works/* tarballs this commit lines up with. */
const UPSTREAM_PACKAGE_VERSION = "0.84.4";
const UPSTREAM_REPO = "https://github.com/earendil-works/pi";
const UPSTREAM_SRC = "packages/coding-agent/src";

const VENDOR_DIR = join(
  REPO_ROOT,
  "examples/next/harnesses/pi/vendor/pi-coding-agent-src"
);
const DEFAULT_LOCAL_REPO = join(
  process.env.HOME ?? "",
  "Documents/Github/pi-mono"
);

interface UpstreamFile {
  /** Path relative to the vendor dir (mirrors the upstream layout). */
  path: string;
  /** Patch file names (in patches/) applied to this file, in order. */
  patches?: string[];
}

/**
 * Files copied from upstream. Everything else in the vendor tree is a stub.
 * Keep this list minimal: each entry drags in its own import graph, which has
 * to be satisfied by a stub at the same relative path.
 */
const UPSTREAM_FILES: UpstreamFile[] = [
  { path: "core/diagnostics.ts" },
  {
    path: "core/extensions/loader.ts",
    patches: ["0001-loader-inline-only.patch"]
  },
  { path: "core/extensions/runner.ts" },
  { path: "core/extensions/types.ts" },
  { path: "core/extensions/wrapper.ts" },
  { path: "core/messages.ts" },
  {
    path: "core/prompt-templates.ts",
    patches: ["0002-prompt-templates-pure.patch"]
  },
  { path: "core/slash-commands.ts" },
  { path: "core/source-info.ts" },
  { path: "core/tools/tool-definition-wrapper.ts" }
];

/**
 * Hand-written stubs. Listed in the manifest so drift in the upstream import
 * graph is visible, but their contents are ours and never regenerated.
 */
const STUB_FILES: string[] = [
  "_stubs/pi-tui.d.ts",
  "config.ts",
  "core/bash-executor.ts",
  "core/compaction/index.ts",
  "core/event-bus.ts",
  "core/exec.ts",
  "core/footer-data-provider.ts",
  "core/keybindings.ts",
  "core/model-registry.ts",
  "core/model-resolver.ts",
  "core/package-manager.ts",
  "core/session-manager.ts",
  "core/skills.ts",
  "core/system-prompt.ts",
  "core/tools/bash.ts",
  "core/tools/edit.ts",
  "core/tools/index.ts",
  "modes/interactive/theme/theme.ts"
];

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024
  });
}

function gitBytes(args: string[], cwd?: string): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/** Resolve the upstream checkout, cloning shallowly when there is none. */
function resolveSourceRepo(): { repo: string; cleanup: () => void } {
  const configured = process.env.PI_REPO;
  if (configured) {
    if (!existsSync(join(configured, ".git"))) {
      throw new Error(`PI_REPO is not a git checkout: ${configured}`);
    }
    return { repo: configured, cleanup: () => {} };
  }
  if (existsSync(join(DEFAULT_LOCAL_REPO, ".git"))) {
    return { repo: DEFAULT_LOCAL_REPO, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-upstream-"));
  console.log(`Cloning ${UPSTREAM_REPO} into ${dir} ...`);
  git(["init", "-q", dir]);
  git(["remote", "add", "origin", UPSTREAM_REPO], dir);
  git(["fetch", "-q", "--depth", "1", "origin", UPSTREAM_COMMIT], dir);
  git(["checkout", "-q", "FETCH_HEAD"], dir);
  return {
    repo: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function assertCommit(repo: string): void {
  const type = git(["cat-file", "-t", UPSTREAM_COMMIT], repo).trim();
  if (type !== "commit") {
    throw new Error(
      `${UPSTREAM_COMMIT} is not a commit in ${repo} (got ${type})`
    );
  }
}

function banner(file: UpstreamFile): string {
  const patched = (file.patches ?? []).length > 0;
  const source = `${UPSTREAM_SRC}/${file.path}`;
  const suffix = patched
    ? ` (patched: ${(file.patches ?? []).join(", ")})`
    : "";
  return [
    `// Vendored from earendil-works/pi @ ${UPSTREAM_COMMIT.slice(0, 8)}${patched ? ", patched for workerd." : ", verbatim."}`,
    `// Upstream: ${source}${suffix}`,
    "// Generated by scripts/vendor-pi-coding-agent.ts - do not edit by hand. See ./README.md",
    "",
    ""
  ].join("\n");
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Write the banner + upstream bytes for every file into a scratch directory,
 * then apply the patches there.
 *
 * Generation always happens in a throwaway git repo: `git apply --3way` needs
 * one, and applying inside the agents repo would silently skip every patched
 * path (git apply ignores paths outside the current subdirectory).
 */
function generate(repo: string, outDir: string): void {
  for (const file of UPSTREAM_FILES) {
    const contents = gitBytes(
      ["show", `${UPSTREAM_COMMIT}:${UPSTREAM_SRC}/${file.path}`],
      repo
    );
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.concat([Buffer.from(banner(file)), contents]));
  }

  const patchDir = join(VENDOR_DIR, "patches");
  const patches = existsSync(patchDir)
    ? readdirSync(patchDir)
        .filter((name) => name.endsWith(".patch"))
        .sort()
    : [];
  if (patches.length === 0) return;

  git(["init", "-q", outDir]);
  git(["add", "-A"], outDir);
  for (const patch of patches) {
    git(["apply", "--3way", join(patchDir, patch)], outDir);
  }
  rmSync(join(outDir, ".git"), { recursive: true, force: true });
}

function buildManifest(outDir: string): string {
  const files: Record<
    string,
    { upstream: string; patches: string[]; sha256: string }
  > = {};
  for (const file of UPSTREAM_FILES) {
    files[file.path] = {
      upstream: `${UPSTREAM_SRC}/${file.path}`,
      patches: file.patches ?? [],
      sha256: sha256(readFileSync(join(outDir, file.path)))
    };
  }
  return `${JSON.stringify(
    {
      upstream: UPSTREAM_REPO,
      commit: UPSTREAM_COMMIT,
      packageVersion: UPSTREAM_PACKAGE_VERSION,
      generatedBy: "scripts/vendor-pi-coding-agent.ts",
      note: "sha256 covers the final vendored bytes (provenance banner + upstream source + patches). Stubs are hand-written and not generated.",
      files,
      stubs: STUB_FILES
    },
    null,
    2
  )}\n`;
}

function main(): void {
  const check = process.argv.includes("--check");
  const { repo, cleanup } = resolveSourceRepo();
  const scratch = mkdtempSync(join(tmpdir(), "pi-vendor-"));
  try {
    assertCommit(repo);
    const outDir = scratch;
    generate(repo, outDir);
    const manifest = buildManifest(outDir);

    if (!check) {
      for (const file of UPSTREAM_FILES) {
        const target = join(VENDOR_DIR, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(outDir, file.path)));
      }
      writeFileSync(join(VENDOR_DIR, "MANIFEST.json"), manifest);
      console.log(
        `Vendored ${UPSTREAM_FILES.length} files from ${UPSTREAM_REPO}@${UPSTREAM_COMMIT.slice(0, 8)} into ${relative(REPO_ROOT, VENDOR_DIR)}`
      );
      return;
    }

    const drift: string[] = [];
    for (const file of UPSTREAM_FILES) {
      const current = join(VENDOR_DIR, file.path);
      if (!existsSync(current)) {
        drift.push(`${file.path}: missing from the vendor tree`);
        continue;
      }
      if (
        sha256(readFileSync(current)) !==
        sha256(readFileSync(join(outDir, file.path)))
      ) {
        drift.push(`${file.path}: differs from a fresh vendor run`);
      }
    }
    const manifestPath = join(VENDOR_DIR, "MANIFEST.json");
    if (!existsSync(manifestPath)) {
      drift.push("MANIFEST.json: missing from the vendor tree");
    } else if (readFileSync(manifestPath, "utf-8") !== manifest) {
      drift.push("MANIFEST.json: differs from a fresh vendor run");
    }
    for (const stub of STUB_FILES) {
      if (!existsSync(join(VENDOR_DIR, stub))) {
        drift.push(`${stub}: stub listed in the manifest is missing`);
      }
    }

    if (drift.length > 0) {
      console.error("Vendored pi sources are out of date:");
      for (const line of drift) console.error(`  - ${line}`);
      console.error("\nRun `pnpm vendor:pi` to regenerate.");
      process.exit(1);
    }
    console.log(
      `Vendored pi sources match ${UPSTREAM_REPO}@${UPSTREAM_COMMIT.slice(0, 8)}.`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    cleanup();
  }
}

main();
