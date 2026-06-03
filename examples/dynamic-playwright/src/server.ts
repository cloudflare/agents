import { createWorker } from "@cloudflare/worker-bundler";
import runnerTemplate from "./runner-template.raw.js";

type Env = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
};

type RunResponse = {
  result?: unknown;
  error?: string;
  logs?: string[];
  warnings?: string[];
  bundleMs?: number;
  runMs?: number;
  workerId?: string;
};

const PLAYWRIGHT_VERSION = "1.3.0";
const USER_CODE_PLACEHOLDER = "/* __USER_CODE__ */ undefined";

function json(data: RunResponse, status = 200): Response {
  return Response.json(data, { status });
}

function createRunnerSource(code: string): string {
  return runnerTemplate.replace(USER_CODE_PLACEHOLDER, `(${code})`);
}

async function buildRunner(code: string) {
  return await createWorker({
    files: {
      "package.json": JSON.stringify({
        dependencies: {
          "@cloudflare/playwright": PLAYWRIGHT_VERSION
        }
      }),
      "wrangler.jsonc": JSON.stringify({
        main: "src/runner.js",
        compatibility_date: "2026-01-28",
        compatibility_flags: ["nodejs_compat"]
      }),
      "src/runner.js": createRunnerSource(code)
    },
    entryPoint: "src/runner.js",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    target: "es2022"
  });
}

let workerCount = 0;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runStart = Date.now();
    try {
      const bundle = await buildRunner(await request.text());

      const worker = env.LOADER.get(
        `dynamic-playwright-${workerCount++}`,
        () => ({
          mainModule: bundle.mainModule,
          modules: bundle.modules,
          compatibilityDate: "2026-01-28",
          compatibilityFlags: ["nodejs_compat"],
          env: {
            BROWSER: env.BROWSER
          }
        })
      );

      return await worker
        .getEntrypoint()
        .fetch(new Request("https://dynamic-playwright.local/run"));
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
          runMs: Date.now() - runStart
        },
        500
      );
    }
  }
} satisfies ExportedHandler<Env>;
