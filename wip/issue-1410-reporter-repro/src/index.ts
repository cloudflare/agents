import { getAgentByName, Agent } from "agents";

interface Env {
  PARENT: DurableObjectNamespace<ParentAgent>;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    }
  });
}

function errorPayload(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

function parentNameFrom(url: URL): string {
  return url.searchParams.get("parent") ?? "demo-parent";
}

export class ParentAgent extends Agent<Env> {
  async onMessage(
    connection: { send(message: string): void },
    message: string | ArrayBuffer
  ): Promise<void> {
    const task =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    connection.send(
      JSON.stringify({
        ok: true,
        phase: "before-subAgent",
        parent: this.describe(),
        task
      })
    );

    const result = await this.spawnChild(task);

    connection.send(
      JSON.stringify({
        ok: true,
        phase: "after-subAgent",
        result
      })
    );
  }

  async spawnChild(task = "spawn child"): Promise<unknown> {
    const childName = `child-${crypto.randomUUID()}`;

    try {
      const child = await this.subAgent(ChildAgent, childName);
      const childResult = await child.ping(task);
      return {
        ok: true,
        parent: this.describe(),
        childName,
        child: childResult
      };
    } catch (error) {
      return {
        ok: false,
        parent: this.describe(),
        childName,
        error: errorPayload(error)
      };
    } finally {
      try {
        this.deleteSubAgent(ChildAgent, childName);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  describe(): Record<string, unknown> {
    return {
      className: this.constructor.name,
      name: this.name,
      idName: this.ctx.id.name,
      parentPath: this.parentPath,
      selfPath: this.selfPath
    };
  }
}

export class ChildAgent extends Agent<Env> {
  async ping(task: string): Promise<unknown> {
    await this.ctx.storage.put("lastPing", { task, at: Date.now() });
    return {
      className: this.constructor.name,
      name: this.name,
      idName: this.ctx.id.name,
      parentPath: this.parentPath,
      selfPath: this.selfPath,
      lastPing: await this.ctx.storage.get("lastPing")
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parent = await getAgentByName(env.PARENT, parentNameFrom(url));

    if (url.pathname === "/") {
      return json({
        name: "cf-sub-agent-io-demo",
        description:
          "Minimal public repro for spawning an agents subAgent from a WebSocket message handler.",
        routes: {
          "GET /http-spawn":
            "Control path: calls parent.spawnChild() over RPC.",
          "WS /ws":
            "Repro path: send any message; onMessage calls parent.spawnChild()."
        }
      });
    }

    if (url.pathname === "/http-spawn") {
      return json(
        await parent.spawnChild("spawned from HTTP/RPC control path")
      );
    }

    if (url.pathname === "/ws") {
      return parent.fetch(request);
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
