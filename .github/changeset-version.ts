import { execSync } from "node:child_process";

// This script is used by the `release.yml` workflow to update the version of the packages being released.
// The standard step is only to run `changeset version` but this does not update the pnpm lockfile.
// So we also run `pnpm install --lockfile-only`, which does this update.
// This is a workaround until this is handled automatically by `changeset version`.
// See https://github.com/changesets/changesets/issues/421.
execSync("pnpm exec changeset version", {
  stdio: "inherit"
});
execSync("pnpm exec oxfmt --write .", {
  stdio: "inherit"
});
execSync("pnpm install --lockfile-only --no-frozen-lockfile", {
  stdio: "inherit"
});
