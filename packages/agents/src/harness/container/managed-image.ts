/**
 * Containers built at runtime from `cloudflare/debian-trixie`, with no
 * image of your own.
 *
 * The first start of a setup runs its steps with `exec()` (create the
 * unprivileged user, install the CLI), writes the bundled daemon, and
 * snapshots the filesystem. Later starts restore the snapshot and are
 * ready as soon as the daemon boots. A snapshot is keyed by the image, the
 * steps, and the daemon build, so changing any of them sets up afresh.
 *
 * The container's entrypoint waits for the daemon to be written and then
 * runs it, so the same entrypoint serves a fresh container (where setup
 * writes the daemon) and a restored one (where it is already there).
 */

import { DAEMON_SOURCE, DAEMON_VERSION } from "./daemon-source.generated";

/** The managed system image: Debian Trixie with Node.js. */
export const MANAGED_IMAGE = "cloudflare/debian-trixie";

/** The unprivileged user CLIs run as, `uid:gid`. */
export const AGENT_USER = "10001:10001";

const DAEMON_DIR = "/opt/harness";

/** Waits for setup to write the daemon, then becomes it. */
export const MANAGED_ENTRYPOINT: readonly string[] = [
  "sh",
  "-c",
  `while [ ! -f ${DAEMON_DIR}/ready ]; do sleep 0.1; done; exec node ${DAEMON_DIR}/daemon.mjs`
];

/**
 * One setup command, run once in the fresh container and kept in its
 * snapshot.
 *
 * Steps run as root by default. A step with `user: "agent"` runs as the
 * user the CLI runs as, with `HOME=/home/agent`: anything it puts in that
 * home (installed plugins and mods, `~/.claude/settings.json`, skills,
 * `~/.codex/config.toml`) is in every session's home, because each session
 * home starts as a copy of it.
 */
export type SetupStep = {
  /** What the step does, for error messages. */
  readonly name: string;
  readonly command: readonly string[];
  /** Who runs it. Default `root`. */
  readonly user?: "root" | "agent";
};

/** The agent user's home, which every session home starts as a copy of. */
export const AGENT_HOME = "/home/agent";

/** Steps every managed agent needs before its own. */
export const BASE_STEPS: readonly SetupStep[] = [
  {
    name: "create the agent user and workspace",
    command: [
      "sh",
      "-c",
      "id -u agent >/dev/null 2>&1 || useradd --create-home --uid 10001 --shell /bin/sh agent; " +
        `mkdir -p /workspace ${DAEMON_DIR} && chown 10001:10001 /workspace`
    ]
  },
  {
    name: "install git",
    command: [
      "sh",
      "-c",
      "command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates)"
    ]
  }
];

/** A stored snapshot and the setup it captured. */
export type SetupSnapshot = {
  readonly key: string;
  readonly snapshot: { readonly id: string };
};

/** Why setup failed. */
export type SetupError = { readonly _tag: "setup"; readonly message: string };

/** How long one setup step may run. */
const STEP_TIMEOUT_MS = 10 * 60_000;
/** How much of a failed step's output is reported. */
const OUTPUT_KEPT = 2_000;

/**
 * The key a snapshot of this setup is stored under.
 *
 * @param steps - The setup steps.
 * @returns A stable key for the image, the steps, and the daemon build.
 */
export async function setupKey(steps: readonly SetupStep[]): Promise<string> {
  const text = JSON.stringify({
    image: MANAGED_IMAGE,
    steps: steps.map((step) => [step.user ?? "root", ...step.command]),
    daemon: DAEMON_VERSION
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function run(
  container: Container,
  step: SetupStep,
  stdin?: string
): Promise<SetupError | undefined> {
  const asAgent = step.user === "agent";
  const process = await container.exec([...step.command], {
    env: {
      HOME: asAgent ? AGENT_HOME : "/root",
      DEBIAN_FRONTEND: "noninteractive"
    },
    ...(asAgent ? { user: AGENT_USER, cwd: AGENT_HOME } : {}),
    stderr: "combined",
    ...(stdin === undefined ? {} : { stdin: new Blob([stdin]).stream() })
  });
  // Kill a step that hangs, but never one that exited: signalling an
  // exited process is an error in the object.
  let exited = false;
  void process.exitCode.then(
    () => (exited = true),
    () => (exited = true)
  );
  const timer = setTimeout(() => {
    if (!exited) process.kill(9);
  }, STEP_TIMEOUT_MS);
  try {
    const output = await process.output();
    if (output.exitCode === 0) return undefined;
    const text = new TextDecoder().decode(output.stdout).slice(-OUTPUT_KEPT);
    return {
      _tag: "setup",
      message: `${step.name} exited with ${output.exitCode}: ${text.trim()}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Set a fresh managed container up: run the steps, install the daemon, and
 * snapshot the result. A failed snapshot is not an error: the container
 * still works, and the next start sets up again.
 *
 * @param container - The running container, started from `MANAGED_IMAGE`
 *   with `MANAGED_ENTRYPOINT`.
 * @param steps - The agent's setup, after `BASE_STEPS`.
 * @param key - The setup's key, from `setupKey`.
 * @returns The snapshot to store, `undefined` when none was taken, or why
 *   setup failed.
 */
export async function setUp(
  container: Container,
  steps: readonly SetupStep[],
  key: string
): Promise<
  | { readonly _tag: "ok"; readonly snapshot: SetupSnapshot | undefined }
  | { readonly _tag: "err"; readonly error: SetupError }
> {
  for (const step of [...BASE_STEPS, ...steps]) {
    const failed = await run(container, step).catch(
      (error: unknown): SetupError => ({
        _tag: "setup",
        message: `${step.name} failed: ${error instanceof Error ? error.message : String(error)}`
      })
    );
    if (failed) return { _tag: "err", error: failed };
  }
  const installed = await run(
    container,
    {
      name: "install the daemon",
      command: [
        "sh",
        "-c",
        `cat > ${DAEMON_DIR}/daemon.mjs && touch ${DAEMON_DIR}/ready`
      ]
    },
    DAEMON_SOURCE
  );
  if (installed) return { _tag: "err", error: installed };
  try {
    const snapshot = await container.snapshotContainer({
      name: `harness-${key}`
    });
    return { _tag: "ok", snapshot: { key, snapshot: { id: snapshot.id } } };
  } catch {
    return { _tag: "ok", snapshot: undefined };
  }
}
