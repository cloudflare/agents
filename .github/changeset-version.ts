import { execSync } from "node:child_process";

// This script is used by the `release.yml` workflow to update the version of the packages being released.
// The standard step is only to run `changeset version` but this does not update the pnpm lockfile.
// So we also run `pnpm install --lockfile-only`, which does this update.
// This is a workaround until this is handled automatically by `changeset version`.
// See https://github.com/changesets/changesets/issues/421.

// `changeset version` generates changelog entries via the GitHub GraphQL API
// (@changesets/changelog-github), which intermittently fails with transient
// network errors like "Premature close". changesets bails cleanly without
// writing files on that failure, so retrying is safe.
function run(command: string) {
  execSync(command, { stdio: "inherit" });
}

function runWithRetries(command: string, attempts = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run(command);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      console.warn(
        `"${command}" failed (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms...`
      );
      execSync(`sleep ${Math.ceil(delayMs / 1000)}`);
    }
  }
}

runWithRetries("pnpm exec changeset version");
run("pnpm exec oxfmt --write .");
run("pnpm install --lockfile-only --no-frozen-lockfile");
