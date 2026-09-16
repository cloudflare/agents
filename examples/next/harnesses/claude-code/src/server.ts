/**
 * One Durable Object per coding session, one container per Durable Object.
 *
 * The object owns nothing about Claude Code. It composes the shared
 * `Harness` capability over `ContainerHarnessRuntime`, which knows a wire
 * rather than a vendor, and names the engine with `claudeCode()`. Swapping
 * in `PiRuntime` or a local runtime would change the runtime line and
 * nothing the browser or the caller does.
 *
 * What the container leg buys: the model loop, its tools and its file system
 * live in a sandbox that can be lost at any moment, while the durable record
 * of what was asked, what was answered and what is still open lives in the
 * Durable Object. An eviction mid-turn costs latency; a container crash
 * costs the workspace and nothing else.
 */
import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { Harness, type HarnessResult } from "@cloudflare/agents-next-harness";
import {
  ContainerHarnessRuntime,
  type HarnessEngineSpec
} from "@cloudflare/agents-next-harness/remote";
// The doorbell path is a wire constant, so it lives in the protocol module
// rather than in the runtime that serves it.
import { HARNESS_DOORBELL_PATH } from "@cloudflare/agents-next-harness/protocol";
import { claudeCode, type ClaudeCodeProtocol } from "./claude-code-protocol";

/** The daemon's fixture engine, typed as the same protocol so the host compiles unchanged. */
function echoEngine(): HarnessEngineSpec<ClaudeCodeProtocol> {
  return { id: "echo", options: null, capabilities: new Set(["requests"]) };
}

export { HarnessDoorbell } from "@cloudflare/agents-next-harness/remote";

/**
 * What the engine needs to reach a model, as container environment. Two
 * shapes, both documented in the README:
 *
 * - AI Gateway (`ANTHROPIC_BASE_URL` set): Claude Code talks to the gateway's
 *   Anthropic endpoint, which holds the provider key (BYOK or Unified
 *   Billing). An authenticated gateway also needs `AI_GATEWAY_TOKEN`, sent
 *   as `cf-aig-authorization` and, because the CLI insists on one, as the
 *   otherwise ignored `ANTHROPIC_API_KEY`. `AI_GATEWAY_PROJECT` tags every
 *   request with `cf-aig-metadata`, so a shared team gateway can attribute
 *   the spend.
 * - Direct: `ANTHROPIC_API_KEY` enters the container as is.
 *
 * Whatever enters the container is reachable by the model's own tools.
 */
function engineCredentials(env: Env): Record<string, string> {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    const token = env.AI_GATEWAY_TOKEN ?? "";
    // One header per line, the format the CLI reads the variable in.
    const headers: string[] = [];
    if (token !== "") headers.push(`cf-aig-authorization: Bearer ${token}`);
    if (env.AI_GATEWAY_PROJECT) {
      headers.push(
        `cf-aig-metadata: ${JSON.stringify({ project: env.AI_GATEWAY_PROJECT })}`
      );
    }
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: token === "" ? "placeholder" : token,
      ...(headers.length === 0
        ? {}
        : { ANTHROPIC_CUSTOM_HEADERS: headers.join("\n") })
    };
  }
  return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "" };
}

/** A prompt run through `run()` may take this long before the caller gives up. */
const RUN_TIMEOUT_MS = 600_000;

export class ClaudeCodeSession extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();

  readonly runtime = new ContainerHarnessRuntime<ClaudeCodeProtocol>({
    id: "container:claude-code",
    // The container binding is declared in wrangler.jsonc, so every
    // incarnation of this class has one.
    container: this.ctx.container as Container,
    port: 8787,
    // The doorbell addresses the object by name, so a session reached by id
    // has none and falls back to the renewal job.
    sessionName: this.ctx.id.name ?? this.ctx.id.toString(),
    launch: {
      enableInternet: true,
      env: engineCredentials(this.env)
    },
    doorbellUrl: this.env.DOORBELL_URL,
    // A Worker behind Cloudflare Access needs a service token on the ring.
    ...(this.env.ACCESS_CLIENT_ID && this.env.ACCESS_CLIENT_SECRET
      ? {
          doorbellHeaders: {
            "CF-Access-Client-Id": this.env.ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": this.env.ACCESS_CLIENT_SECRET
          }
        }
      : {}),
    sessions: this.sessions,
    // The engine is chosen here, at the composition root, so the id the
    // daemon boots with and the id the handshake checks cannot disagree.
    // `HARNESS_ENGINE=echo` runs the daemon's echo engine: a keyless smoke
    // deploy of the whole path.
    engine:
      // Wrangler types the var as its configured literal; compare as text.
      String(this.env.HARNESS_ENGINE) === "echo"
        ? echoEngine()
        : claudeCode({
            model: "claude-opus-5",
            permissionMode: "default",
            allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
            ask: ["Bash", "WebFetch"],
            budget: { maxUsd: 5 }
          }),
    idle: {
      detachAfterIdleMs: 20_000,
      keepAliveMs: 900_000,
      stopContainerAfterIdleMs: 120_000
    }
  });

  readonly harness = new Harness<ClaudeCodeProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.runtime,
    // A human answering a permission prompt is slower than a model.
    policy: { requestTimeoutMs: 600_000 }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.webSockets)
    .use(this.harness);

  /**
   * Run one prompt to completion. Native RPC bypasses `fetch`, so the
   * lifecycle is started explicitly. The operation id is derived from the
   * text, which makes a retried call idempotent instead of a second turn.
   */
  async run(text: string): Promise<HarnessResult<ClaudeCodeProtocol>> {
    await this.lifecycle.start();
    const session = this.harness.session();
    const { operationId } = await session.prompt(text, {
      operationId: `run:${await digest(text)}`
    });
    return session.wait(operationId, { timeoutMs: RUN_TIMEOUT_MS });
  }

  /**
   * Host-only demo routes under `/agents/claude-code-session/<name>/`:
   * `info` reports the container generation and whether the platform still
   * has it running, so a reader can watch the idle policy park and stop the
   * container; `restart` evicts the object to show a turn surviving it;
   * `kill` destroys the container to show the next prompt resuming the
   * engine's own conversation from the transcript this object holds.
   */
  async onRequest(request: Request): Promise<Response> {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    if (request.method === "GET" && segments.at(-1) === "info") {
      const info = await this.runtime.info();
      return Response.json({
        ...info,
        status: (await this.harness.session().status()).state
      });
    }
    if (request.method === "POST" && segments.at(-1) === "restart") {
      // Evict this object after replying, so a reader can watch a turn the
      // container is still running survive the eviction: the outbox holds
      // the frames, the doorbell wakes a fresh incarnation, and reconcile
      // replays them.
      setTimeout(() => this.ctx.abort("restart requested from the demo"), 50);
      return new Response(null, { status: 202 });
    }
    if (request.method === "POST" && segments.at(-1) === "kill") {
      // Destroy the container, workspace and all. The next prompt launches a
      // fresh one and hands the engine back the transcript this object kept,
      // so the model remembers the conversation the dead container ran.
      await this.runtime.stop("killed from the demo");
      return new Response(null, { status: 202 });
    }
    return new Response("Not found", { status: 404 });
  }

  /** The daemon rings here when frames pile up with nobody attached. */
  async harnessDoorbell(request: Request): Promise<Response> {
    await this.lifecycle.start();
    return this.runtime.doorbell(request);
  }
}

/** A stable operation id for the same prompt text. */
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(bytes)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** `ctx.exports` is newer than the generated environment types. */
type ExportsContext = ExecutionContext & {
  readonly exports: {
    HarnessDoorbell(options: {
      readonly props: { readonly namespace: string };
    }): Fetcher;
  };
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(HARNESS_DOORBELL_PATH)) {
      // The daemon cannot address a Durable Object; this entrypoint can.
      return (ctx as ExportsContext).exports
        .HarnessDoorbell({ props: { namespace: "ClaudeCodeSession" } })
        .fetch(request);
    }
    if (url.pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    return (
      (await routeAgentRequest(request, env, { cors: true })) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
