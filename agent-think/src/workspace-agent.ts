import {
  type DurableObjectStorageLike,
  Workspace,
  type WorkspaceBackend,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub
} from "@cloudflare/workspace";
import { CloudflareContainerBackend } from "@cloudflare/workspace/backends/container";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
import { DurableObject } from "cloudflare:workers";
import { releaseContainer, resolveContainerId } from "./pool";

export { WorkspaceProxy, WorkspaceServiceProxy };

const RESET_ABORT_DELAY_MS = 100;
const SYNC_RETRY_KEY_PREFIX = "workspace:sync-retry:";

type WorkspaceSyncRetryIntent = {
  backend: string;
  attempt: number;
  notBefore: number;
};

type WorkspaceSyncRetryResult =
  | { status: "idle" | "complete"; backend: string }
  | {
      status: "pending" | "exhausted";
      backend: string;
      attempt: number;
      error: string;
      notBefore?: number;
    };

type WorkspaceWithPendingRetry = Workspace & {
  retryPendingSync?: (backend?: string) => Promise<WorkspaceSyncRetryResult>;
};

/**
 * Compatibility boundary for the Workspace pending-sync retry API. The
 * published alpha may not expose these fields yet; unknown constructor options
 * are harmless there, while a newer Workspace consumes this scheduler.
 */
type WorkspaceOptionsWithPendingRetry = ConstructorParameters<
  typeof Workspace
>[0] & {
  retryScheduler: {
    get(backend: string): Promise<WorkspaceSyncRetryIntent | undefined>;
    schedule(intent: WorkspaceSyncRetryIntent): Promise<void>;
    clear(backend: string): Promise<void>;
  };
};

/**
 * One Workspace-owning Durable Object per Think session. Think transcript and
 * submission SQL live in ThinkAgent; only this object constructs Workspace and
 * therefore only this object's SQLite database contains VFS tables.
 */
export class WorkspaceAgent extends DurableObject<Env> {
  readonly #backend: CloudflareContainerBackend;
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const workspaceRef = { binding: "WorkspaceAgent", id: ctx.id.toString() };
    this.#backend = new CloudflareContainerBackend({
      id: "container",
      container: async () => {
        const uuid = await resolveContainerId(env, ctx.id.toString());
        return env.Sandbox.get(env.Sandbox.idFromName(uuid));
      },
      workspace: workspaceRef
    });
    const backends: WorkspaceBackend[] = [];
    if (env.LOADER) {
      backends.push(
        new WorkerBackend({
          id: "shell",
          loader: env.LOADER,
          workspace: workspaceRef,
          ctx
        })
      );
    }
    backends.push(this.#backend);
    const workspaceOptions: WorkspaceOptionsWithPendingRetry = {
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends,
      retryScheduler: {
        get: (backend) => this.#getSyncRetry(backend),
        schedule: (intent) => this.#scheduleSyncRetry(intent),
        clear: (backend) => this.#clearSyncRetry(backend)
      }
    };
    this.#workspace = new Workspace(workspaceOptions);
  }

  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ws") {
      return this.#backend.handleFetch(request);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }

  async alarm(): Promise<void> {
    const due = await this.#listSyncRetries();
    for (const intent of due.filter((item) => item.notBefore <= Date.now())) {
      const retry = (this.#workspace as WorkspaceWithPendingRetry)
        .retryPendingSync;
      if (typeof retry !== "function") {
        // Compatibility mode: preserve the durable signal until Workspace is
        // upgraded rather than pretending the missing retry completed.
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
      await retry.call(this.#workspace, intent.backend);
    }
    await this.#armNextSyncRetry();
  }

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  async exec(
    command: string,
    options: {
      cwd?: string;
      encoding: "utf8";
      backend?: string;
      timeoutMs?: number;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const handle = await this.#workspace.shell.exec(command, options);
    const result = await handle.result();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async closeWorkspace(): Promise<void> {
    try {
      await this.#workspace.close();
    } finally {
      await releaseContainer(this.env, this.ctx.id.toString());
    }
  }

  async resetWorkspace(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.closeWorkspace();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    } catch (error) {
      errors.push(error);
    }
    setTimeout(() => this.ctx.abort(), RESET_ABORT_DELAY_MS);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Workspace reset did not fully complete"
      );
    }
  }

  async debugIdentity(): Promise<{ id: string }> {
    return { id: this.ctx.id.toString() };
  }

  async debugScheduleSyncRetryForTest(
    intent: WorkspaceSyncRetryIntent
  ): Promise<void> {
    await this.#scheduleSyncRetry(intent);
  }

  async debugPendingSyncRetryForTest(
    backend: string
  ): Promise<WorkspaceSyncRetryIntent | undefined> {
    return this.#getSyncRetry(backend);
  }

  async #getSyncRetry(
    backend: string
  ): Promise<WorkspaceSyncRetryIntent | undefined> {
    return this.ctx.storage.get<WorkspaceSyncRetryIntent>(
      `${SYNC_RETRY_KEY_PREFIX}${backend}`
    );
  }

  async #scheduleSyncRetry(intent: WorkspaceSyncRetryIntent): Promise<void> {
    await this.ctx.storage.put(
      `${SYNC_RETRY_KEY_PREFIX}${intent.backend}`,
      intent
    );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || intent.notBefore < alarm) {
      await this.ctx.storage.setAlarm(intent.notBefore);
    }
  }

  async #clearSyncRetry(backend: string): Promise<void> {
    await this.ctx.storage.delete(`${SYNC_RETRY_KEY_PREFIX}${backend}`);
    await this.#armNextSyncRetry();
  }

  async #listSyncRetries(): Promise<WorkspaceSyncRetryIntent[]> {
    return [
      ...(await this.ctx.storage.list<WorkspaceSyncRetryIntent>({
        prefix: SYNC_RETRY_KEY_PREFIX
      }))
    ].map(([, intent]) => intent);
  }

  async #armNextSyncRetry(): Promise<void> {
    // Workspace leaves exhausted intents durable for inspection. Only a future
    // intent is actionable; re-arming an exhausted, past-due intent would make
    // the WorkspaceAgent alarm hot-loop.
    const next = (await this.#listSyncRetries())
      .map((intent) => intent.notBefore)
      .filter((notBefore) => notBefore > Date.now());
    if (next.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...next));
  }

  /** Dev/e2e proof of bidirectional sync with generated-path filtering. */
  async debugWorkspaceSync(): Promise<{
    hostFileVisibleInContainer: boolean;
    sourceFileDurable: boolean;
    localTempFileDurable: boolean;
    sourceFileRestoredAfterContainerReplacement: boolean;
    localTempFileRestoredAfterContainerReplacement: boolean;
  }> {
    const id = crypto.randomUUID();
    const root = `/workspace/sync-${id}`;
    const hostPath = `${root}/host.txt`;
    const sourcePath = `${root}/src/source.txt`;
    const localTempPath = `/temp/sync-${id}.log`;

    await this.#workspace.fs.mkdir(root, { recursive: true });
    await this.#workspace.fs.writeFile(hostPath, "host");
    const handle = await this.#workspace.shell.exec(
      [
        "set -e",
        `test -f ${shellQuote(hostPath)}`,
        `mkdir -p ${shellQuote(sourcePath.slice(0, sourcePath.lastIndexOf("/")))}`,
        `printf source > ${shellQuote(sourcePath)}`,
        `mkdir -p /temp && printf local > ${shellQuote(localTempPath)}`
      ].join("\n"),
      { encoding: "utf8", backend: "container" }
    );
    const result = await handle.result();
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);

    const sourceFileDurable =
      (await this.#workspace.fs.readFile(sourcePath, "utf8")) === "source";
    let localTempFileDurable = true;
    try {
      await this.#workspace.fs.stat(localTempPath);
    } catch (error) {
      localTempFileDurable = !isEnoent(error);
    }

    await this.closeWorkspace();
    const replacement = await this.#workspace.shell.exec(
      `test -f ${shellQuote(sourcePath)}; source=$?; test -f ${shellQuote(localTempPath)}; local=$?; printf '%s %s' "$source" "$local"`,
      { encoding: "utf8", backend: "container" }
    );
    const replacementResult = await replacement.result();
    const [sourceStatus, localStatus] = replacementResult.stdout
      .trim()
      .split(/\s+/)
      .map(Number);
    await this.closeWorkspace();

    return {
      hostFileVisibleInContainer: true,
      sourceFileDurable,
      localTempFileDurable,
      sourceFileRestoredAfterContainerReplacement: sourceStatus === 0,
      localTempFileRestoredAfterContainerReplacement: localStatus === 0
    };
  }
}

function isEnoent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string };
  return (
    value.code === "ENOENT" ||
    (typeof value.message === "string" && /ENOENT|no such/i.test(value.message))
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
