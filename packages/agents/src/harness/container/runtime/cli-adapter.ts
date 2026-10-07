/**
 * An adapter for any agent CLI that runs one turn per process and prints
 * JSON lines: Claude Code (`claude -p --output-format stream-json`), Codex
 * (`codex exec --json`), or your own.
 *
 * A CLI is described by three things:
 *
 * - `command`: the argv (and stdin) for one turn, given the prompt, the
 *   session's settings, and the state earlier turns reported, such as the
 *   CLI's own session id to resume.
 * - `parser`: turns each stdout line into `ContainerEvent`s, state updates,
 *   and the turn's outcome.
 * - `stateDirs`: where the CLI keeps its sessions, relative to `$HOME`.
 *
 * Each harness session gets its own `$HOME`, so sessions sharing a
 * container never see each other's CLI state. The working directory is
 * shared. Everything the CLI writes under `stateDirs`, and every state
 * update, is persisted to the Durable Object while the turn runs; in a new
 * container both are restored before the first turn, so the CLI resumes
 * its own session. Forks need nothing special: a fork's home starts as a
 * copy of its parent's.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chown,
  copyFile,
  mkdir,
  readdir,
  readlink,
  symlink
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  inputText,
  type ContainerEvent,
  type ContainerOutcome,
  type ContainerSettings,
  type JsonValue
} from "../protocol";
import {
  type AdapterContext,
  type AdapterSession,
  type AdapterTurn,
  type ContainerAdapter
} from "../daemon-core";
import { FileMirror } from "./file-mirror";
import { isJsonObject } from "./json";

/** String values a CLI reported in earlier turns, such as its session id. */
export type CliState = { readonly [key: string]: string };

/** What a command and a parser are given for one turn. */
export type CliTurn = {
  readonly operationId: string;
  /** The prompt's text. Image parts are not passed to CLIs. */
  readonly prompt: string;
  readonly settings: ContainerSettings;
  readonly state: CliState;
};

/** How to start one turn. */
export type CliCommand = {
  readonly argv: readonly string[];
  /** Written to the process's stdin, which is then closed. */
  readonly stdin?: string;
  /** Added to the environment. */
  readonly env?: { readonly [name: string]: string };
};

/** What one stdout line meant. */
export type CliUpdate = {
  readonly events?: readonly ContainerEvent[];
  /** Merged into the session's state and persisted. */
  readonly state?: CliState;
  /** The turn's outcome, when the line reports it. */
  readonly outcome?: ContainerOutcome;
};

/** Reads one turn's output. */
export type CliParser = {
  line(text: string): CliUpdate;
  /** The outcome when no line reported one, from how the process exited. */
  end(exit: {
    readonly code: number | null;
    readonly stderr: string;
  }): ContainerOutcome;
};

/** `cliAdapter`'s options. */
export type CliAdapterOptions = {
  /** Reported in `hello`, such as `"codex"`. */
  readonly id: string;
  readonly version?: string;
  readonly command: (turn: CliTurn) => CliCommand;
  readonly parser: (turn: CliTurn) => CliParser;
  /** Directories under `$HOME` where the CLI keeps its sessions. */
  readonly stateDirs?: readonly string[];
  /** Working directory. Default `/workspace`. */
  readonly cwd?: string;
  /** Where session homes are created. Default `~/.harness/sessions`. */
  readonly homes?: string;
  /** How often a running turn's state is persisted. Default 5 seconds. */
  readonly syncIntervalMs?: number;
  /**
   * A home to start every session home from: whatever setup installed
   * there (plugins, mods, settings, skills) is in each session's home. The
   * session files under `stateDirs` are then restored on top. Default: none.
   */
  readonly skeleton?: string;
  /**
   * Run the CLI as this user, and give it its home. For a daemon running
   * as root: Claude Code, for one, refuses to skip permission prompts as
   * root. Default: the daemon's own user.
   */
  readonly user?: { readonly uid: number; readonly gid: number };
};

/** How long a CLI has to exit after an interrupt before it is killed. */
const KILL_AFTER_MS = 5_000;
/** How much stderr is kept for an error message. */
const STDERR_KEPT = 4_096;

/** The session state folded from persisted `{ kind: "state" }` entries. */
function foldState(entries: readonly JsonValue[]): CliState {
  const state: Record<string, string> = {};
  for (const entry of entries) {
    if (!isJsonObject(entry) || entry.kind !== "state") continue;
    const values = entry.values;
    if (!isJsonObject(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string") state[key] = value;
    }
  }
  return state;
}

/** Give a directory tree to a user. */
async function chownTree(
  path: string,
  user: { readonly uid: number; readonly gid: number }
): Promise<void> {
  await chown(path, user.uid, user.gid);
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await chownTree(child, user);
    else await chown(child, user.uid, user.gid).catch(() => undefined);
  }
}

/**
 * Copy a skeleton home into a session home, keeping what is already there
 * and leaving out the session homes themselves when they live inside it.
 * (`fs.cp` refuses to copy a directory into its own subdirectory, filter
 * or not, so this walks the tree itself.)
 */
async function seed(
  skeleton: string,
  home: string,
  homes: string
): Promise<void> {
  const excluded = resolve(homes);
  const walk = async (from: string, to: string): Promise<void> => {
    const entries = await readdir(from, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      const source = join(from, entry.name);
      const path = resolve(source);
      if (path === excluded || path.startsWith(excluded + sep)) continue;
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        await mkdir(target, { recursive: true });
        await walk(source, target);
      } else if (entry.isSymbolicLink()) {
        await symlink(await readlink(source), target).catch(() => undefined);
      } else if (entry.isFile()) {
        await copyFile(source, target, constants.COPYFILE_EXCL).catch(
          () => undefined
        );
      }
    }
  };
  await walk(resolve(skeleton), home);
}

function homeFor(root: string, session: string): string {
  // Hashed: session ids are arbitrary strings, directory names are not.
  return join(
    root,
    createHash("sha256").update(session).digest("hex").slice(0, 32)
  );
}

class CliSession implements AdapterSession {
  readonly #options: CliAdapterOptions;
  readonly #context: AdapterContext;
  readonly #home: string;
  readonly #mirror: FileMirror;
  #state: CliState;
  #settings: ContainerSettings;
  /** Mirror syncs run one at a time. */
  #syncing: Promise<void> = Promise.resolve();

  constructor(
    options: CliAdapterOptions,
    context: AdapterContext,
    home: string,
    mirror: FileMirror
  ) {
    this.#options = options;
    this.#context = context;
    this.#home = home;
    this.#mirror = mirror;
    this.#state = foldState(context.restore);
    this.#settings = context.settings;
  }

  async run(turn: AdapterTurn): Promise<ContainerOutcome> {
    const cliTurn: CliTurn = {
      operationId: turn.operationId,
      prompt: inputText(turn.input),
      settings: this.#settings,
      state: this.#state
    };
    const command = this.#options.command(cliTurn);
    const parser = this.#options.parser(cliTurn);
    const [file, ...args] = command.argv;
    if (file === undefined) throw new Error("The CLI command is empty");

    const user = this.#options.user;
    const child = spawn(file, args, {
      cwd: this.#options.cwd ?? "/workspace",
      env: { ...process.env, ...command.env, HOME: this.#home },
      stdio: ["pipe", "pipe", "pipe"],
      ...(user ? { uid: user.uid, gid: user.gid } : {})
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(command.stdin ?? "");

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEPT);
    });

    let outcome: ContainerOutcome | undefined;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (text) => {
      if (text.trim() === "") return;
      let update: CliUpdate;
      try {
        update = parser.line(text);
      } catch (error) {
        this.#context.log("warn", `unreadable CLI output: ${String(error)}`);
        return;
      }
      for (const event of update.events ?? []) this.#context.emit(event);
      if (update.state) this.#remember(update.state);
      if (update.outcome) outcome = update.outcome;
    });

    const onAbort = () => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS).unref();
    };
    turn.signal.addEventListener("abort", onAbort, { once: true });
    const sync = setInterval(
      () => void this.#sync(),
      this.#options.syncIntervalMs ?? 5_000
    );

    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        resolve(null);
      });
      child.on("close", (exitCode) => resolve(exitCode));
    });
    clearInterval(sync);
    turn.signal.removeEventListener("abort", onAbort);
    // Everything the turn wrote is persisted before it settles.
    await this.#sync();

    if (turn.signal.aborted) return { status: "unanswered", reason: "aborted" };
    return outcome ?? parser.end({ code, stderr });
  }

  configure(settings: ContainerSettings): void {
    this.#settings = settings;
  }

  async close(): Promise<void> {
    await this.#syncing;
  }

  #remember(update: CliState): void {
    const changed = Object.entries(update).some(
      ([key, value]) => this.#state[key] !== value
    );
    if (!changed) return;
    this.#state = { ...this.#state, ...update };
    this.#context.persist([{ kind: "state", values: { ...update } }]);
  }

  #sync(): Promise<void> {
    this.#syncing = this.#syncing.then(async () => {
      try {
        const entries = await this.#mirror.collect();
        if (entries.length > 0) this.#context.persist(entries);
      } catch (error) {
        this.#context.log("warn", `state sync failed: ${String(error)}`);
      }
    });
    return this.#syncing;
  }
}

/**
 * An adapter for an agent CLI.
 *
 * @param options - The CLI's command, parser, and state directories.
 * @returns The adapter.
 *
 * @experimental The API may change before it stabilizes.
 */
export function cliAdapter(options: CliAdapterOptions): ContainerAdapter {
  const homes = options.homes ?? join(homedir(), ".harness", "sessions");
  return {
    id: options.id,
    version: options.version ?? "1",
    capabilities: ["resume", "fork", "model"],
    async open(context) {
      const home = homeFor(homes, context.session);
      await mkdir(home, { recursive: true });
      if (options.skeleton) await seed(options.skeleton, home, homes);
      const mirror = new FileMirror(home, options.stateDirs ?? []);
      await mirror.restore(context.restore);
      if (options.user) await chownTree(home, options.user);
      return new CliSession(options, context, home, mirror);
    }
  };
}
