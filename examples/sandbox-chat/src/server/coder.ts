import { getSandbox, parseSSEStream, type ISandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  type OpencodeServer
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Config } from "@opencode-ai/sdk/v2";
import type { CoderToolOutput } from "./types";
import { OpenCodeStreamAccumulator } from "./opencode-stream";

// ── OpenCode config ─────────────────────────────────────────────────

/**
 * Build the OpenCode config for the Cloudflare Workers AI provider
 * using Kimi K2.5. The baseURL is set explicitly with the account ID
 * baked in — the provider's env-var interpolation does not work
 * reliably inside the sandbox container.
 */
function getOpencodeConfig(accountId: string): Config {
  return {
    model: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.5",
    provider: {
      "cloudflare-workers-ai": {
        options: {
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
        },
        models: {
          "@cf/moonshotai/kimi-k2.5": {}
        }
      }
    },
    permission: {
      read: "allow",
      edit: "allow",
      bash: "allow",
      write: "allow",
      mcp: "allow"
    },
    autoupdate: false
  };
}

// ── Coder manager ───────────────────────────────────────────────────

/**
 * Manages the OpenCode server/client lifecycle and exposes `runCoder()`
 * as an async generator that yields sub-conversation snapshots.
 */
export class CoderManager {
  private server: OpencodeServer | null = null;
  private client: OpencodeClient | null = null;

  /**
   * Ensure the OpenCode server + client are running. Reuses the
   * server across invocations but creates a new session each time.
   */
  private async ensureOpencode(
    sandbox: ISandbox,
    env: { CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_API_KEY: string }
  ): Promise<OpencodeClient> {
    if (this.client && this.server) {
      return this.client;
    }

    const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
      directory: "/workspace",
      config: getOpencodeConfig(env.CLOUDFLARE_ACCOUNT_ID),
      env: {
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_API_KEY: env.CLOUDFLARE_API_KEY
      }
    });

    // Register the API key in OpenCode's credential store so the
    // provider can authenticate requests.
    await client.auth.set({
      providerID: "cloudflare-workers-ai",
      auth: {
        type: "api",
        key: env.CLOUDFLARE_API_KEY
      }
    });

    this.server = server;
    this.client = client;
    return client;
  }

  /**
   * Delegate a coding task to an autonomous OpenCode agent inside
   * the sandbox. Yields CoderToolOutput snapshots as preliminary
   * tool results containing the growing sub-conversation; the final
   * yield includes the completed conversation and summary.
   */
  async *runCoder(
    prompt: string,
    sandboxBinding: DurableObjectNamespace,
    sandboxName: string,
    env: {
      AI: Ai;
      CLOUDFLARE_ACCOUNT_ID: string;
      CLOUDFLARE_API_KEY: string;
    },
    backupFn: () => Promise<void>,
    signal?: AbortSignal
  ): AsyncGenerator<CoderToolOutput> {
    // Validate required credentials before attempting anything
    const missing: string[] = [];
    if (!env.CLOUDFLARE_ACCOUNT_ID) missing.push("CLOUDFLARE_ACCOUNT_ID");
    if (!env.CLOUDFLARE_API_KEY) missing.push("CLOUDFLARE_API_KEY");
    if (missing.length > 0) {
      yield {
        status: "error" as const,
        sessionId: "",
        messages: [],
        error: [
          `Coder tool is not configured \u2014 missing environment variable(s): ${missing.join(", ")}.`,
          "These must be set as secrets or in .dev.vars for local development.",
          "See: https://developers.cloudflare.com/workers-ai/get-started/rest-api/"
        ].join(" ")
      };
      return;
    }

    const sandbox = getSandbox(sandboxBinding, sandboxName);
    const client = await this.ensureOpencode(sandbox, env);
    const session = await client.session.create({
      title: prompt.slice(0, 80)
    });

    if (!session.data) {
      yield {
        status: "error" as const,
        sessionId: "",
        messages: [],
        error: `Failed to create OpenCode session: ${JSON.stringify(session.error ?? session)}`
      };
      return;
    }

    const sessionId = session.data.id;
    const accumulator = new OpenCodeStreamAccumulator(sessionId);

    // Yield initial state so the client shows something immediately
    yield accumulator.getSnapshot();

    // Open the SSE event stream directly via containerFetch so we get
    // a true streaming response.
    const server = this.server;
    if (!server) {
      yield {
        status: "error" as const,
        sessionId,
        messages: [],
        error: "OpenCode server not running"
      };
      return;
    }
    const sseResp = await sandbox.containerFetch(
      new Request(`${server.url}/event`),
      server.port
    );
    if (!sseResp.ok || !sseResp.body) {
      yield {
        status: "error" as const,
        sessionId,
        messages: [],
        error: `Event stream failed: ${sseResp.status} ${sseResp.statusText}`
      };
      return;
    }

    // Fire-and-forget: promptAsync returns immediately while the agent works.
    await client.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text" as const, text: prompt }]
    });

    // Inactivity timeout — if no SSE event arrives within this window
    // the stream is considered stalled and we break out.
    const INACTIVITY_TIMEOUT_MS = 120_000;
    const THROTTLE_MS = 200;
    let lastYieldAt = Date.now();

    try {
      for await (const ev of parseSSEStream<{
        type: string;
        properties?: Record<string, unknown>;
      }>(sseResp.body, signal)) {
        // Reset inactivity watchdog on every event
        const inactivityTimer = setTimeout(() => {
          try {
            sseResp.body!.cancel();
          } catch {
            /* ignore */
          }
        }, INACTIVITY_TIMEOUT_MS);

        // Process event through the accumulator
        accumulator.processEvent(ev);

        // Yield throttled snapshots as preliminary results
        const now = Date.now();
        if (accumulator.dirty && now - lastYieldAt >= THROTTLE_MS) {
          yield accumulator.getSnapshot();
          lastYieldAt = now;
        }

        // Check for terminal states
        if (
          accumulator.status === "complete" ||
          accumulator.status === "error"
        ) {
          clearTimeout(inactivityTimer);
          break;
        }

        clearTimeout(inactivityTimer);
      }
    } catch (err) {
      if (accumulator.status === "working") {
        // Force error state if we haven't already transitioned
        accumulator.processEvent({
          type: "session.error",
          properties: {
            sessionID: sessionId,
            error: err instanceof Error ? err.message : "Event stream failed"
          }
        });
      }
    }

    // Backup workspace after the coder makes changes
    await backupFn();

    // Final yield (non-preliminary)
    yield accumulator.getSnapshot();
  }
}
