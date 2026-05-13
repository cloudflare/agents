import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/voice.ts", "src/voice-client.ts", "src/voice-react.tsx"],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
