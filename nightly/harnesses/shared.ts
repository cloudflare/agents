/**
 * What the two harness Workers share: the witness object, the control
 * routes, and the model id for the real conversations. Each harness is its
 * own Worker (`pi.ts`, `opencode.ts`), so neither carries the other's bundle
 * into its startup.
 *
 * `/ctl/<kind>/<room>/<method>` (POST, a JSON array of arguments) calls the
 * object's `probe*` method. A room whose name starts with `real-` talks to
 * Workers AI; any other room to the scripted model.
 */
import { DurableObject } from "cloudflare:workers";

export type BaseEnv = {
  PROBE_KEY: string;
  BUILD: string;
  AI: Ai;
  Witness: DurableObjectNamespace<Witness>;
};

export const REAL_MODEL = "@cf/zai-org/glm-4.7-flash";
export const RELEASE_KEY = "probe:release";

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[])
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/**
 * Records what the probes' tools and objects did, outside them: a suite can
 * read it without waking a probe, so a probe that comes back after a reset
 * shows it was its own wake job that brought it back.
 */
export class Witness extends DurableObject<BaseEnv> {
  async bump(key: string): Promise<number> {
    const n = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.put(key, n);
    return n;
  }
  async read(key: string): Promise<number> {
    return (await this.ctx.storage.get<number>(key)) ?? 0;
  }
}

/** The Worker's fetch handler: `/ready`, the witness, and `kind`'s probes. */
export function probeWorker<Env extends BaseEnv>(
  kind: string,
  probes: (env: Env) => DurableObjectNamespace
): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const key =
        request.headers.get("x-probe-key") ?? url.searchParams.get("key");
      if (!env.PROBE_KEY || key !== env.PROBE_KEY)
        return new Response("Not found", { status: 404 });
      if (url.pathname === "/ready") return new Response(`ready:${env.BUILD}`);
      const w = url.pathname.match(/^\/witness\/([^/]+)\/(\w[\w-]*)$/);
      if (w)
        return Response.json({
          ok: true,
          value: await env.Witness.getByName(w[1]).read(w[2])
        });
      const m = url.pathname.match(/^\/ctl\/(\w+)\/([^/]+)\/(probe\w+)$/);
      if (!m || m[1] !== kind)
        return new Response("Not found", { status: 404 });
      const [, , room, method] = m;
      const args = (await request.json()) as unknown[];
      try {
        const stub = probes(env).getByName(room) as unknown as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >;
        return Response.json({
          ok: true,
          value: (await stub[method](...args)) ?? null
        });
      } catch (e) {
        return Response.json({ ok: false, error: String(e).slice(0, 300) });
      }
    }
  };
}
