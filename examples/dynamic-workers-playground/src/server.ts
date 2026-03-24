import { exports } from "cloudflare:workers";
import { createWorker } from "@cloudflare/worker-bundler";
import { handleGitHubImport } from "./github";

export { DynamicWorkerTail, LogSession } from "./logging";

type LoaderExports = {
  LogSession: {
    getByName(name: string): {
      waitForLogs(): Promise<{
        getLogs(timeoutMs: number): Promise<unknown[]>;
      }>;
    };
  };
  DynamicWorkerTail(options: { props: { workerId: string } }): Fetcher;
};

const runtimeExports = exports as LoaderExports;

interface BundleInfo {
  mainModule: string;
  modules: string[];
  warnings: string[];
}

interface WorkerState {
  bundleInfo: BundleInfo | null;
  buildTime: number;
}

interface RunRequestBody {
  files: Record<string, string>;
  version: number;
  pathname?: string;
  options?: {
    bundle?: boolean;
    minify?: boolean;
  };
}

async function createWorkerId(
  files: Record<string, string>,
  options?: RunRequestBody["options"]
): Promise<string> {
  const sortedFiles = Object.keys(files)
    .sort()
    .map((path) => [path, files[path]]);

  const payload = JSON.stringify({
    files: sortedFiles,
    bundle: options?.bundle ?? true,
    minify: options?.minify ?? false
  });

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload)
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, 16);

  return `dynamic-workers-playground-worker-${hash}`;
}

async function executeWorker(
  worker: WorkerStub,
  state: WorkerState,
  workerId: string,
  pathname = "/"
): Promise<Response> {
  const entrypoint = worker.getEntrypoint() as Fetcher & {
    __warmup__?: () => Promise<void>;
  };

  const loadStart = Date.now();
  try {
    await entrypoint.__warmup__?.();
  } catch {
    // Warmup intentionally calls a method that does not exist so the worker cold-starts.
  }
  const loadTime = Date.now() - loadStart;

  const { buildTime, bundleInfo } = state;
  const logSessionStub = runtimeExports.LogSession.getByName(workerId);
  const logWaiter = await logSessionStub.waitForLogs();

  const runStart = Date.now();
  const request = new Request(
    `https://example.com${pathname.startsWith("/") ? pathname : `/${pathname}`}`
  );

  let workerResponse: Response;
  let responseBody = "";
  let workerError: { message: string; stack?: string } | null = null;

  try {
    workerResponse = await entrypoint.fetch(request);
    responseBody = await workerResponse.text();

    if (workerResponse.status >= 500) {
      workerError = {
        message: responseBody || "Worker returned an internal error."
      };
    }
  } catch (error) {
    workerError = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    };
    workerResponse = new Response("Worker execution failed", { status: 500 });
  }

  const runTime = Date.now() - runStart;
  const logs = await logWaiter.getLogs(1000);

  const headers: Record<string, string> = {};
  workerResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return Response.json({
    bundleInfo: bundleInfo ?? {
      mainModule: "(cached)",
      modules: [],
      warnings: []
    },
    response: {
      status: workerResponse.status,
      headers,
      body: responseBody
    },
    workerError,
    logs,
    timing: {
      buildTime,
      loadTime,
      runTime,
      totalTime: buildTime + loadTime + runTime
    }
  });
}

function buildErrorResponse(error: unknown): Response {
  console.error("Error in dynamic-workers-playground:", error);
  return Response.json(
    {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined
    },
    { status: 500 }
  );
}

function normalizeFiles(files: Record<string, string>): Record<string, string> {
  const normalized = Object.fromEntries(
    Object.entries(files)
      .map(([path, contents]) => [path.trim(), contents])
      .filter(([path]) => path.length > 0)
  );

  if (!normalized["package.json"]) {
    const entryPoint =
      normalized["src/index.ts"] || normalized["src/index.js"]
        ? Object.keys(normalized).find(
            (file) => file === "src/index.ts" || file === "src/index.js"
          )
        : Object.keys(normalized).find(
            (file) => file.endsWith(".ts") || file.endsWith(".js")
          );

    normalized["package.json"] = JSON.stringify(
      {
        name: "dynamic-workers-playground-worker",
        main: entryPoint ?? "src/index.ts"
      },
      null,
      2
    );
  }

  return normalized;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/github" && request.method === "POST") {
      return handleGitHubImport(request);
    }

    if (url.pathname === "/api/run" && request.method === "POST") {
      try {
        const { files, pathname, options } =
          (await request.json()) as RunRequestBody;

        if (!files || Object.keys(files).length === 0) {
          return Response.json(
            { error: "At least one source file is required." },
            { status: 400 }
          );
        }

        const normalizedFiles = normalizeFiles(files);
        const workerId = await createWorkerId(normalizedFiles, options);
        const state: WorkerState = {
          bundleInfo: null,
          buildTime: 0
        };
        const contextExports = (ctx as unknown as { exports: LoaderExports })
          .exports;

        const worker = env.LOADER.get(workerId, async () => {
          const buildStart = Date.now();
          const { mainModule, modules, wranglerConfig, warnings } =
            await createWorker({
              files: normalizedFiles,
              bundle: options?.bundle ?? true,
              minify: options?.minify ?? false
            });

          state.buildTime = Date.now() - buildStart;
          state.bundleInfo = {
            mainModule,
            modules: Object.keys(modules),
            warnings: warnings ?? []
          };

          return {
            mainModule,
            modules: modules as Record<string, string>,
            compatibilityDate:
              wranglerConfig?.compatibilityDate ?? "2026-01-01",
            compatibilityFlags: wranglerConfig?.compatibilityFlags ?? [],
            env: {
              API_KEY: "sk-example-key-12345",
              DEBUG: "true",
              WORKER_ID: workerId
            },
            globalOutbound: null,
            tails: [
              contextExports.DynamicWorkerTail({
                props: { workerId }
              })
            ]
          };
        });

        return executeWorker(worker, state, workerId, pathname ?? "/");
      } catch (error) {
        return buildErrorResponse(error);
      }
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
