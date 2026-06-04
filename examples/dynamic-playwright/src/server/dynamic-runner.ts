import { createWorker } from "@cloudflare/worker-bundler";
import runnerTemplate from "../runner-template.raw.js?raw";

const PUPPETEER_VERSION = "1.1.0";

interface Deps {
  loader: WorkerLoader;
  browser: Fetcher;
}

export type RunScriptOptions = {
  captureScreenshot?: boolean;
};

export async function runScript(
  code: string,
  sessionId: string,
  { browser, loader }: Deps,
  options: RunScriptOptions = {}
): Promise<Response> {
  const bundle = await buildRunner(code);

  const worker = loader.load({
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    compatibilityDate: "2026-01-28",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      BROWSER: browser,
      CAPTURE_SCREENSHOT: options.captureScreenshot ? "true" : "false",
      SESSION_ID: sessionId
    }
  });

  return await worker
    .getEntrypoint()
    .fetch(new Request("https://dynamic-playwright.local/run"));
}

async function buildRunner(code: string) {
  return await createWorker({
    files: {
      "package.json": JSON.stringify({
        dependencies: {
          "@cloudflare/puppeteer": PUPPETEER_VERSION
        }
      }),
      "wrangler.jsonc": JSON.stringify({
        main: "src/runner.js",
        compatibility_date: "2026-01-28",
        compatibility_flags: ["nodejs_compat"]
      }),
      "src/runner.js": runnerTemplate,
      "src/user.js": code
    },
    entryPoint: "src/runner.js",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    target: "es2022"
  });
}
