import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/lib.ts"],
    // Bundle all runtime dependencies (tiged, yargs, and their transitive
    // deps) into the output so the published package is fully self-contained.
    // `npm create think` is then a single download that runs with no extra
    // installs. Node built-ins stay external automatically. Keep tiged/yargs
    // in devDependencies so they are inlined here and never installed by
    // consumers (e.g. `@cloudflare/think`, which imports `./lib`).
    noExternal: [/.*/],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
