import { execSync } from "node:child_process";

execSync("pnpm exec tsx ./.github/resolve-workspace-versions.ts", {
  stdio: "inherit"
});
execSync("pnpm exec changeset publish", {
  stdio: "inherit"
});
