import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

/** Calls to the fake Bot API, by test agent (the bot token). */
const botApiCalls = new Map<string, Array<{ method: string; body: unknown }>>();
let botMessageId = 100;

async function fakeTelegramBotApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // The replay talks to the fake Bot API only: anything else fails it.
  if (url.hostname !== "fake-telegram.test") {
    throw new Error(`Unexpected outbound request to ${url.hostname}`);
  }
  if (url.pathname === "/__calls") {
    return Response.json(
      botApiCalls.get(url.searchParams.get("bot") ?? "") ?? []
    );
  }
  const [, botPath, method] = url.pathname.split("/");
  const bot = (botPath ?? "").replace(/^bot/, "");
  const body = request.headers.get("content-type")?.includes("json")
    ? ((await request.json()) as Record<string, unknown>)
    : {};
  const calls = botApiCalls.get(bot) ?? [];
  calls.push({ method: method ?? "", body });
  botApiCalls.set(bot, calls);
  if (method === "getMe") {
    return Response.json({
      ok: true,
      result: {
        id: 999,
        is_bot: true,
        first_name: "Probe",
        username: "probe_bot"
      }
    });
  }
  return Response.json({
    ok: true,
    result: {
      message_id: botMessageId++,
      date: 1767225700,
      chat: { id: body.chat_id, type: "private" },
      text: body.text
    }
  });
}

export default defineConfig({
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      },
      miniflare: {
        // The fake Telegram Bot API the recorded-webhook replay points its
        // adapter at. Any other host fails. Its own config: an outbound
        // service changes how other tests' failed fetches look.
        // SAFETY: Miniflare hands undici's Request and takes its Response,
        // which Node's global ones are.
        outboundService: fakeTelegramBotApi as never
      }
    })
  ],
  test: {
    name: "workers-replay",
    include: [path.join(testsDir, "messenger-replay.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 10000,
    retry: 0,
    // Under the full parallel matrix, tearing down the workers-pool isolates can
    // overrun vitest's 10s default and surface as "Worker exited unexpectedly"
    // (an infra teardown race, not a test failure that `retry` can catch). Give
    // the pool room to terminate cleanly so a slow teardown can't red an
    // otherwise-green run.
    teardownTimeout: 60_000,
    deps: {
      optimizer: {
        ssr: {
          include: ["ajv"]
        }
      }
    }
  }
});
