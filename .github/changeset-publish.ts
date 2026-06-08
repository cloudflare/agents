import { execSync } from "node:child_process";

execSync("vp exec tsx ./.github/resolve-workspace-versions.ts", {
  stdio: "inherit"
});
execSync("vp exec changeset publish", {
  stdio: "inherit"
});
