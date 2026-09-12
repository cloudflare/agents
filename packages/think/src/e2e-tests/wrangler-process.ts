import { execSync, type ChildProcess } from "node:child_process";

/**
 * SIGKILL whatever still listens on `port` — a server left behind by an
 * aborted earlier run.
 */
export function killProcessOnPort(port: number): void {
  try {
    const output = execSync(
      `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`
    )
      .toString()
      .trim();
    for (const pid of output.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  } catch {
    // lsof unavailable.
  }
}

/**
 * SIGKILL a `wrangler dev` process and everything it spawned, atomically.
 *
 * The child must have been spawned with `detached: true`, which makes it the
 * leader of its own process group; killing the group takes down `npm exec`,
 * wrangler, esbuild, and every workerd in one signal.
 *
 * Walking the tree with `pgrep -P` and killing children first does not
 * work: each `pgrep` takes milliseconds, and in that window wrangler — still
 * alive — notices workerd died and respawns it. The respawned workerd is
 * not in the snapshot, survives the walk as an orphan, and keeps the port,
 * so the "restarted" wrangler fails with "Address already in use" and the
 * interrupted turn the test meant to recover simply finishes on the old
 * server instead.
 */
export function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    // Clear the fallback timer once the child exits — an uncleared timer
    // keeps the vitest worker's event loop alive and can push teardown past
    // the pool's termination window.
    const fallback = setTimeout(resolve, 3000);
    child.on("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  });
}
