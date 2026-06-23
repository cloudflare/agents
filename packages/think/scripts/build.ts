import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { build as viteBuild } from "vite";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: [
      "src/think.ts",
      "src/workflows.ts",
      "src/extensions/index.ts",
      "src/framework/index.ts",
      "src/react.tsx",
      "src/server-entry.ts",
      "src/messengers/index.ts",
      "src/messengers/telegram.ts",
      "src/tools/workspace.ts",
      "src/tools/execute.ts",
      "src/tools/extensions.ts",
      "src/tools/browser.ts",
      "src/tools/sandbox.ts",
      "src/cli/index.ts",
      "src/vite.ts"
    ],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  // Build the Think Studio SPA into dist/studio. The app's deps (react, vite,
  // kumo, ai-chat, …) are build-time devDependencies; only the prebuilt static
  // bundle ships, and the `think studio` runtime serves it with `node:http`.
  await viteBuild({
    root: path.join(packageRoot, "studio"),
    configFile: path.join(packageRoot, "studio/vite.config.ts"),
    logLevel: "warn"
  });

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
