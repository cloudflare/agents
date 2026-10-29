// Test worker for WorkerJavaScriptBackend, used without @cloudflare/computer:
// a Durable Object gives the backend its own SQLite and an in-memory
// filesystem, connects it, and runs code through the handle.
import { DurableObject } from "cloudflare:workers";
import {
  WorkerJavaScriptBackend,
  type WorkerJavaScriptBackendOptions,
  type WorkspaceModuleBackendHandle,
  type WorkspaceRuntimeDatabase,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeValue
} from "../index";
import { MemoryFilesystem } from "./memory-filesystem";

// The result crosses RPC to the test as JSON text: `WorkspaceRuntimeValue`
// is recursive, which the RPC stub types can't expand.
export interface RunResult {
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  result?: string;
}

export interface RunOptions {
  input?: Record<string, number | string>;
  timeoutMs?: number;
  backend?: "default" | "short-timeout";
}

interface Env {
  LOADER: WorkerLoader;
}

// BLOB columns come back from `ctx.storage.sql` as ArrayBuffer; the
// backend wants Uint8Array.
function sqlDatabase(storage: DurableObjectStorage): WorkspaceRuntimeDatabase {
  function all<Row extends object>(
    query: string,
    ...bindings: unknown[]
  ): Row[] {
    return storage.sql
      .exec(query, ...bindings)
      .toArray()
      .map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] =
            value instanceof ArrayBuffer ? new Uint8Array(value) : value;
        }
        return out as Row;
      });
  }
  return {
    run(query, ...bindings) {
      storage.sql.exec(query, ...bindings);
    },
    all,
    one<Row extends object>(query: string, ...bindings: unknown[]) {
      return all<Row>(query, ...bindings)[0];
    },
    transactionSync: (closure) => storage.transactionSync(closure)
  };
}

async function collect(
  events: ReadableStream<WorkspaceRuntimeEvent>
): Promise<Omit<RunResult, "id">> {
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let result: string | undefined;
  for await (const event of events) {
    if (event.name === "stdout") stdout += decoder.decode(event.value);
    else if (event.name === "stderr") stderr += decoder.decode(event.value);
    else {
      exitCode = event.code;
      if ("result" in event) result = JSON.stringify(event.result);
    }
  }
  return {
    exitCode,
    stdout,
    stderr,
    ...(result === undefined ? {} : { result })
  };
}

interface Services {
  greeting: string;
}

export class BackendTestHost extends DurableObject<Env> {
  readonly fs = new MemoryFilesystem();
  readonly db = sqlDatabase(this.ctx.storage);
  #handles = new Map<string, Promise<WorkspaceModuleBackendHandle>>();

  #handle(kind: NonNullable<RunOptions["backend"]>) {
    let handle = this.#handles.get(kind);
    if (!handle) {
      const options: WorkerJavaScriptBackendOptions<Services> = {
        loader: this.env.LOADER,
        modules: {
          "ws:math": {
            add: ([a, b]) => Number(a) + Number(b)
          },
          "ws:greeter": Object.assign(
            (services: Services) => ({
              greet: ([name]: readonly WorkspaceRuntimeValue[]) =>
                `${services.greeting}, ${String(name)}`
            }),
            { description: "Greets people." }
          ),
          "shout-kit":
            "export const shout = (text) => text.toUpperCase() + '!';"
        },
        ...(kind === "short-timeout"
          ? { id: "short-timeout", maxTimeoutMs: 200 }
          : {})
      };
      const backend = new WorkerJavaScriptBackend(options);
      handle = backend.connect({
        db: this.db,
        fs: this.fs,
        greeting: "Hello"
      });
      this.#handles.set(kind, handle);
    }
    return handle;
  }

  async describe(): Promise<string> {
    return new WorkerJavaScriptBackend<Services>({
      loader: this.env.LOADER,
      modules: {
        "ws:greeter": Object.assign(() => ({ greet: () => "" }), {
          description: "Greets people."
        })
      }
    }).description;
  }

  async run(source: string, options: RunOptions = {}): Promise<RunResult> {
    const handle = await this.#handle(options.backend ?? "default");
    const execution = await handle.exec({
      source,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    });
    return { id: execution.id, ...(await collect(execution.events)) };
  }

  // Read a finished execution back from SQLite through a fresh handle, as
  // a restarted Durable Object would.
  async replay(id: string): Promise<Omit<RunResult, "id">> {
    const handle = await new WorkerJavaScriptBackend({
      loader: this.env.LOADER
    }).connect({ db: this.db, fs: this.fs });
    const execution = await handle.getExec({ id });
    return collect(execution.events);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
      recursive: true
    });
    await this.fs.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    return this.fs.readFile(path, "utf8");
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  }
};
