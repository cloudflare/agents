import * as fs from "node:fs";
import { execSync } from "node:child_process";
async function main() {
  try {
    console.log("Getting current git hash...");
    const stdout = execSync("git rev-parse --short HEAD").toString();
    console.log("Git hash:", stdout.trim());

    for (const path of [
      "./packages/agents/package.json",
      "./packages/hono-agents/package.json",
    ]) {
      const packageJson = JSON.parse(fs.readFileSync(path, "utf-8"));
      packageJson.version = `0.0.0-${stdout.trim()}`;
      fs.writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
