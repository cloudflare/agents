import { execSync } from "node:child_process";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsdown";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: ["src/index.ts", "src/workers.ts", "src/node.ts", "src/embedded.ts"],
    skipNodeModulesBundle: true,
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // tsdown produces hashed .d.ts names for shared chunks; rename entry
  // points so they match the paths declared in package.json exports.
  const dist = "./dist";
  for (const file of readdirSync(dist)) {
    if (!file.endsWith(".d.ts")) continue;
    for (const entry of ["index", "workers", "node", "embedded"]) {
      if (file.startsWith(`${entry}-`)) {
        renameSync(join(dist, file), join(dist, `${entry}.d.ts`));
      }
    }
  }

  execSync("oxfmt --write ./dist/*.d.ts");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
