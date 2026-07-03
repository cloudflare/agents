/**
 * Sandbox — container-host Durable Object. One per Cloudflare
 * Container; minted by the warm pool; lives for the lifetime of
 * that container.
 *
 * Wiring: cross-DO. The *Agent* DO owns the `Workspace` instance
 * and the `CloudflareContainerBackend` that drives wsd. The backend's
 * `container: () => ...` factory returns a stub to one of these
 * Sandboxes; the backend then calls `getWorkspaceContainer()` over
 * Workers RPC to reach the runtime container handle.
 *
 * That makes this class deliberately near-empty:
 *
 *   - `withWorkspaceContainer` installs `getWorkspaceContainer()`,
 *     which the backend uses to drive `ctx.container.start()`,
 *     `ctx.container.interceptOutboundHttp()`, and
 *     `ctx.container.getTcpPort()`. That's the whole point of
 *     this DO.
 *
 *   - `WorkspaceProxy` is re-exported at the worker entrypoint
 *     (not here \u2014 it's a top-level export in `index.ts`) so wsd's
 *     `/ws` callback can route back into the Agent DO that owns
 *     the workspace.
 *
 *   - Three lifecycle methods (`startAndWaitForPorts`, `stop`,
 *     `getState`) survive only because the warm pool driver calls
 *     them. Each is a direct pass-through to `ctx.container.*`
 *     with no synthesised state. The pool branches on
 *     `getState().status === "healthy"`, mapped from
 *     `ctx.container.running`.
 *
 * What's *gone* compared to the prior shape: no Workspace instance,
 * no CloudflareContainerBackend, no `getWorkspace()` or `gitClone()`
 * RPC, no synthetic connect-state tracking. All of that moved to
 * the Agent DO where the Workspace now lives.
 */

import { withWorkspaceContainer } from "@cloudflare/workspace/backends/container";
import { DurableObject } from "cloudflare:workers";

/**
 * Lifecycle snapshot the warm pool reads via `getState()`.
 * `lastChange` exists so the pool's idle/health checks have
 * something monotone to compare against \u2014 `ctx.container.running`
 * doesn't carry a timestamp.
 */
export interface SandboxState {
  lastChange: number;
  status: "healthy" | "stopped";
}

interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

class SandboxBase extends DurableObject<SandboxEnv> {}

export class Sandbox extends withWorkspaceContainer(SandboxBase) {
  #lastChange = Date.now();

  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env);
    if (!ctx.container) {
      throw new Error(
        "Sandbox DO is not container-enabled. Check wrangler.jsonc " +
          "for a `containers` entry whose class_name is `Sandbox`."
      );
    }
    // Reconcile stale post-deploy containers eagerly, in
    // blockConcurrencyWhile so no inbound RPC sees the half-state.
    //
    // The deploy pattern: every Sandbox DO isolate restarts under a
    // platform that may keep the underlying container alive across
    // the deploy. The new isolate's module-level WeakMap (used by
    // @cloudflare/workspace's container-lifecycle.ts) is empty.
    // Crucially the platform-level egress intercept rules installed
    // by a prior isolate's `ctx.container.interceptOutboundHttp(...)`
    // do not survive that restart either — wsd's already-bound
    // network stack is in a state we can't re-steer, and the
    // Agent's next dial sees:
    //   CloudflareContainerBackend(container) [stage=connect]:
    //     POST /connect returned 502: upstream /health unreachable
    // when wsd's fetch("http://workspace.internal/...") trips on
    // unresolved DNS.
    //
    // Detection: at constructor time we haven't started anything
    // yet, so `ctx.container.running === true` is unambiguous — it's
    // a leftover container we inherited. Destroy + recreate it
    // through the upstream API so the next dial's interceptOutboundHttp
    // applies to a fresh wsd. Failures are swallowed so a flaky
    // platform restart never prevents the isolate from booting; the
    // Agent's backend has its own restart-on-readiness budget and
    // will surface a wedged container that way instead.
    if (ctx.container.running) {
      ctx.blockConcurrencyWhile(async () => {
        const container = ctx.container;
        if (!container) return;
        try {
          // NOT host.restart(): for an inherited container this isolate has
          // no lifecycle monitor installed, so restart()'s destroy() resolves
          // before the container actually stops and its immediate start()
          // throws "start() cannot be called on a container that is already
          // running" — leaving the wedged container in place. Destroy, wait
          // for `running` to actually drop, then start the replacement.
          await container.destroy().catch(() => {});
          const deadline = Date.now() + 30_000;
          while (container.running && Date.now() < deadline) await sleep(500);
          if (container.running) {
            throw new Error("container still running 30s after destroy()");
          }
          const host = this.getWorkspaceContainer();
          await host.start({ PORT: "8080", MOUNT_POINT: "/workspace" });
          console.info({
            message: "Sandbox: reconciled stale post-deploy container",
            component: "sandbox",
            sandboxId: ctx.id.toString()
          });
          this.#lastChange = Date.now();
        } catch (error) {
          console.warn({
            message: "Sandbox: stale-container reconcile failed",
            component: "sandbox",
            sandboxId: ctx.id.toString(),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  }

  // Previously this DO also exposed `containerFetch(port, req, init)`
  // returning a plain `{ ok, status, body }` envelope so our forked
  // `CrossDOContainerBackend` could route /health and /connect
  // through the container-owning DO without crossing a Fetcher
  // back over Workers RPC. alpha.9's `WorkspaceContainerAPI.fetchPort(...)`
  // does the same thing and is installed automatically by
  // `withWorkspaceContainer`; the upstream `CloudflareContainerBackend`
  // calls it directly. Both the bespoke method here and the fork
  // are gone in alpha.9.

  // ── Warm-pool surface ────────────────────────────────────────────
  //
  // All three methods are RPC entries the warm pool driver calls
  // on a Sandbox stub. None of them carry workspace state \u2014 the
  // Agent DO owns that.

  /**
   * Pre-warm the container by starting it. The warm pool calls this
   * when filling idle slots so the first Agent to dial doesn't pay
   * the boot cost. Routes through `WorkspaceContainerAPI.start()`
   * (rather than `ctx.container.start()` directly) so the lifecycle
   * monitor is installed alongside the container start — important
   * for the post-deploy reconciliation logic in
   * `getWorkspaceContainer` above to be able to tell "this isolate
   * started this container" from "this isolate inherited a running
   * container from a previous incarnation."
   *
   * We don't probe the wsd port from here — that's the backend's
   * job in the Agent DO's `connect()` path. This call only buys the
   * container-image pull + VM start time.
   */
  async startAndWaitForPorts(): Promise<void> {
    const container = this.ctx.container;
    if (!container) return;
    // host.start() is idempotent on a running container (the upstream
    // WorkspaceContainerAPI short-circuits when running && !priorExit).
    // After the constructor's reconcile, this is either a fresh start
    // or a no-op against the restart we just kicked off.
    const host = this.getWorkspaceContainer();
    await host.start({ PORT: "8080", MOUNT_POINT: "/workspace" });
    this.#lastChange = Date.now();
  }

  /**
   * Stop the running container. Pool calls this for idle eviction
   * and slot recycling. `ctx.container.destroy()` tears down the
   * VM; the next `start()` rebuilds it from the image.
   *
   * Best-effort: a double-stop or an already-exited container
   * shouldn't crash the pool's eviction sweep.
   */
  async stop(_signal?: string): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    try {
      await container.destroy();
    } catch {
      // already exited / lost the handle. pool can't recover
      // regardless; next start will rebuild.
    }
    this.#lastChange = Date.now();
  }

  /**
   * Synthetic container state. The warm pool branches on
   * `status === "healthy"` (good to hand out) and `status === "stopped"`
   * (re-warm needed). Map `ctx.container.running` directly.
   */
  async getState(): Promise<SandboxState> {
    return {
      lastChange: this.#lastChange,
      status: this.ctx.container?.running ? "healthy" : "stopped"
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
