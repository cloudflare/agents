/**
 * agent-think worker entrypoint.
 *
 * Two surfaces:
 *
 *   1. `AgentThink` (WorkerEntrypoint) — the RPC surface the gh-app
 *      webhook service calls over a service binding. gh-app owns the
 *      GitHub App: it verifies the webhook, parses `@agent-think
 *      <verb> …` out of an issue comment, mints a short-lived
 *      installation token, and calls `dispatch(...)` with it. This
 *      worker holds NO GitHub App credentials — only the per-turn
 *      installation token it is handed — so it is safe to open-source
 *      as a public example while gh-app stays private in GitLab.
 *
 *   2. `fetch` — a thin HTTP surface: `/` health text and
 *      `/agents/...` routed to the Think DO so the live thread UI
 *      (and the container `/ws` upgrade) work. No issue ingress over
 *      HTTP; that only comes through `dispatch`.
 *
 * The ThinkAgent class and the Workspace loopback proxies are
 * re-exported so the runtime can find them by class name (DO /
 * container bindings in wrangler.jsonc). There is no Workflow: the
 * turn runs natively via the Think agent's durable submitMessages.
 */

import { getAgentByName, routeAgentRequest } from "agents";
import { ThinkAgent, WorkspaceProxy, WorkspaceServiceProxy } from "./agent";
import { CommandCenterAgent } from "./command-center";
import { Sandbox } from "./sandbox";
import { WarmPool } from "./warm-pool";
import { primePool } from "./pool";

// ThinkAgent owns the Workspace; Sandbox is the container-host DO the warm
// pool hands out; WarmPool keeps one container pre-warmed. The proxies let
// wsd's /ws callback route back into the Agent DO that owns the workspace.
export {
  ThinkAgent,
  CommandCenterAgent,
  Sandbox,
  WarmPool,
  WorkspaceProxy,
  WorkspaceServiceProxy
};

/**
 * The dispatch payload gh-app sends per invocation. `installationToken`
 * is a short-lived GitHub App installation token scoped to the repo;
 * the agent uses it for all `gh` / `git` operations for this turn.
 *
 * The user invokes the agent as `@agent-think <instruction>` — a single
 * free-form instruction ("reproduce this", "open a PR fixing it", "see
 * if this still repros on wrangler 4.100 and if so patch it"). The
 * agent reads it and follows the matching skill(s); there is no fixed
 * verb.
 *
 * agent-think acts as ITSELF (the GitHub App identity) — it does not
 * impersonate the triggering user. Branches, commits, and PRs are
 * authored by the app.
 */
export interface DispatchInput {
  repo: string;
  issueNumber: number;
  /** Free-form instruction the user typed after `@agent-think`. */
  instruction: string;
  /** Short-lived GitHub App installation token, minted by gh-app. */
  installationToken: string;
  /**
   * The triggering issue-comment id. Drives turn idempotency: the same
   * comment never starts two turns (RPC retries, at-least-once delivery),
   * but a NEW mention on the same issue always starts a fresh turn.
   */
  commentId?: number;
}

export interface DispatchResult {
  /** Stable agent/session name — also the slug in the share-UI URL. */
  session: string;
  /** Public link to the live thread UI. */
  threadUrl: string;
  /** Durable submission id for the started turn (for log correlation). */
  submissionId: string;
}

import { WorkerEntrypoint } from "cloudflare:workers";

export class AgentThink extends WorkerEntrypoint<Env> {
  /**
   * Start a repro/pr run for an issue. Returns immediately with a
   * link to the live thread; the turn runs to completion in the
   * background (Think's durable submission) and reports back on the
   * issue itself.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    return runDispatch(this.env, input);
  }
}

/**
 * Shared dispatch: resolve the per-issue agent, set its context, and
 * start the durable turn. Used by both the RPC entrypoint (gh-app) and
 * the dev-only HTTP route (local e2e harness).
 */
async function runDispatch(
  env: Env,
  input: DispatchInput
): Promise<DispatchResult> {
  const session = sessionName(input.repo, input.issueNumber);
  const agent = await getAgentByName<Env, ThinkAgent>(env.ThinkAgent, session);
  await agent.setContext({
    repo: input.repo,
    issueNumber: input.issueNumber,
    instruction: input.instruction,
    installationToken: input.installationToken,
    commentId: input.commentId
  });
  const submissionId = await agent.start();
  const threadUrl = `${publicBaseUrl(env)}/thread/${session}`;
  return { session, threadUrl, submissionId };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Dev-only local trigger + readback, so `wrangler dev --local` can drive a
    // real run end-to-end (real container, real Workspace) without gh-app. The
    // production deploy sets no LOCAL_DEV var, so these 404 there.
    if ((env as { LOCAL_DEV?: string }).LOCAL_DEV === "1") {
      if (request.method === "POST" && url.pathname === "/dev/dispatch") {
        const body = (await request.json()) as {
          repo?: string;
          issueNumber?: number;
          instruction?: string;
          installationToken?: string;
        };
        if (!body.repo || typeof body.issueNumber !== "number") {
          return Response.json(
            { error: "repo + issueNumber required" },
            { status: 400 }
          );
        }
        try {
          const result = await runDispatch(env, {
            repo: body.repo,
            issueNumber: body.issueNumber,
            instruction: body.instruction ?? "reproduce this issue",
            installationToken: body.installationToken ?? ""
          });
          return Response.json(result, { status: 202 });
        } catch (error) {
          // Surface the failure synchronously so `curl /dev/dispatch` shows the
          // real error (the gh-app path swallows it in waitUntil).
          return Response.json(
            {
              error: error instanceof Error ? error.message : String(error),
              stack:
                error instanceof Error ? error.stack?.slice(0, 2000) : undefined
            },
            { status: 500 }
          );
        }
      }
      const readback = url.pathname.match(/^\/dev\/messages\/([^/]+)$/);
      if (request.method === "GET" && readback) {
        const agent = await getAgentByName<Env, ThinkAgent>(
          env.ThinkAgent,
          decodeURIComponent(readback[1])
        );
        return Response.json(await agent.debugMessages());
      }
    }

    // The agents WebSocket transport lives under /agents/*; route it to
    // the ThinkAgent DO so the thread UI can stream the live message log.
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    // SPA fallback: `/` (the command center) and /thread/:session are
    // client-side routes, so serve the built index.html and let the React app
    // route on the path. In prod the assets layer serves `/` directly (it is
    // not in run_worker_first); this branch also covers environments where
    // asset-first routing is not emulated (vitest pool, some dev setups).
    // `run_worker_first: ["/thread/*"]` funnels thread URLs here; hashed
    // JS/CSS assets are served directly by the assets layer.
    if (
      url.pathname.startsWith("/thread/") ||
      url.pathname === "/" ||
      url.pathname === ""
    ) {
      const asset = await env.ASSETS.fetch(new URL("/index.html", url.origin));
      return new Response(asset.body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    return new Response("not found", { status: 404 });
  },

  // Cron: keep the warm pool primed. `primePool` pushes the current config
  // (WARM_POOL_TARGET etc.) to the WarmPool DO and kicks its alarm loop, which
  // pre-starts containers up to the target so the first dial skips boot cost.
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      primePool(env).catch((err) =>
        console.error(
          "agent-think primePool failed:",
          err instanceof Error ? err.message : String(err)
        )
      )
    );
  }
} satisfies ExportedHandler<Env>;

/**
 * Stable per-issue session name. Both verbs on the same issue reuse
 * the same DO — so `@agent-think pr` inherits the workspace, clone,
 * and thread that `@agent-think repro` already built up, and a
 * re-invocation of either verb continues the same session.
 */
function sessionName(repo: string, issueNumber: number): string {
  const slug = repo.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `${slug}-${issueNumber}`;
}

/**
 * Public origin for building share links. Set `PUBLIC_BASE_URL` in
 * wrangler vars to the worker's route; falls back to the workers.dev
 * hostname pattern otherwise.
 */
function publicBaseUrl(env: Env): string {
  const configured = (env as unknown as { PUBLIC_BASE_URL?: string })
    .PUBLIC_BASE_URL;
  return configured && configured.length > 0
    ? configured.replace(/\/$/, "")
    : "";
}
