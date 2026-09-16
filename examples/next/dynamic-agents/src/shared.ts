/**
 * Wire contract shared by the server and the client. Must not import
 * anything from cloudflare:workers — it is bundled into the browser.
 */

export type GadgetInfo = { name: string; version: number };

/** Full editor payload for one stored gadget. */
export type GadgetDetails = GadgetInfo & { code: string };

/**
 * The default gadget: a Durable Object class that counts invocations
 * in its own private SQLite. The named `Sandbox` export is required —
 * the supervisor mounts it via `getDurableObjectClass("Sandbox")`.
 */
export const DEFAULT_GADGET_CODE = `import { DurableObject } from "cloudflare:workers";

export class Sandbox extends DurableObject {
  fetch(request) {
    const url = new URL(request.url);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (path TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO hits (path, n) VALUES (?, 1) ON CONFLICT (path) DO UPDATE SET n = n + 1",
      url.pathname
    );
    const [{ n }] = this.ctx.storage.sql
      .exec("SELECT n FROM hits WHERE path = ?", url.pathname)
      .toArray();
    return Response.json({ version: "v1", path: url.pathname, hits: n });
  }
}
`;
