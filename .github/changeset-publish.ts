import { execSync } from "node:child_process";

execSync("npx tsx ./.github/resolve-workspace-versions.ts");
execSync("npx changeset publish");
