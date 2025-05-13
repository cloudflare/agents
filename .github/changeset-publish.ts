import { execSync } from "node:child_process";

execSync("npx tsx ./.github/resolve-workspace-versions.ts", {
  stdio: "inherit",
});
execSync("npx changeset publish", {
  stdio: "inherit",
});
