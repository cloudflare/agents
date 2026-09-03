import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { createWorkersAI } from "workers-ai-provider";
import {
  CodexHarness,
  type CodexOperationResult,
  type CodexOperationSnapshot
} from "./codex-harness";
import type { KernelJson } from "./kernel-types";

type HarnessHost = {
  readonly codex: CodexHarness;
  readonly workspace: Workspace;
  restart(): void;
};

type PromptRequest = {
  readonly prompt?: unknown;
  readonly operationId?: unknown;
};

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** Plain Durable Object composed with the static Codex Lifecycle capability. */
export class Coder extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex"
  });
  readonly model = createWorkersAI({
    binding: this.env.AI,
    gateway: {
      id: "default",
      metadata: { codex_transport: "language-model-v4" }
    }
  })(MODEL);
  readonly codex = new CodexHarness({
    tasks: this.tasks,
    streams: this.streams,
    workspace: this.workspace,
    model: this.model
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.codex);

  onRequest(request: Request): Promise<Response> {
    return handleHarnessRequest(this, request);
  }

  restart(): void {
    this.ctx.abort("codex harness restart verification");
  }
}

async function handleHarnessRequest(
  host: HarnessHost,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).slice(2);
  const operationId = parts.at(1);

  if (request.method === "POST" && parts[0] === "submit") {
    const body = (await request.json().catch(() => ({}))) as PromptRequest;
    if (typeof body.prompt !== "string") {
      return json({ error: "prompt must be a string" }, { status: 400 });
    }
    const receipt = await host.codex.submit({
      prompt: body.prompt,
      ...(typeof body.operationId === "string"
        ? { operationId: body.operationId }
        : {})
    });
    return json(receipt, { status: receipt.accepted ? 202 : 200 });
  }

  if (
    request.method === "GET" &&
    parts[0] === "operations" &&
    operationId !== undefined
  ) {
    const snapshot = await host.codex.snapshot(operationId);
    return snapshot
      ? json(snapshot)
      : json({ error: "operation not found" }, { status: 404 });
  }

  if (
    request.method === "GET" &&
    parts[0] === "results" &&
    operationId !== undefined
  ) {
    const result = await host.codex.getResult(operationId);
    return result
      ? json(result)
      : json({ error: "result not ready" }, { status: 404 });
  }

  if (
    request.method === "GET" &&
    parts[0] === "events" &&
    operationId !== undefined
  ) {
    const snapshot = await host.codex.snapshot(operationId);
    if (!snapshot) {
      return json({ error: "operation not found" }, { status: 404 });
    }
    return json({ events: await host.codex.events(operationId) });
  }

  if (
    request.method === "POST" &&
    parts[0] === "abort" &&
    operationId !== undefined
  ) {
    return json({ aborted: await host.codex.abort(operationId) });
  }

  if (request.method === "GET" && parts[0] === "file") {
    const path = url.searchParams.get("path") ?? "/codex/result.txt";
    const content = await host.workspace.readFile(path);
    return content === null
      ? json({ path, found: false }, { status: 404 })
      : json({ path, found: true, content });
  }

  if (request.method === "POST" && parts[0] === "restart") {
    setTimeout(() => host.restart(), 50);
    return json({ restarting: true });
  }

  return json({
    runtime: "static-wasm",
    routes: [
      "POST submit",
      "GET operations/:operationId",
      "GET results/:operationId",
      "GET events/:operationId",
      "POST abort/:operationId",
      "GET file?path=/codex/result.txt",
      "POST restart"
    ]
  });
}

function json(
  value:
    | KernelJson
    | CodexOperationSnapshot
    | CodexOperationResult
    | Record<string, unknown>,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        name: "next-codex-harness",
        codexCommit: "5e26f7621c1c470fe62350d61c9eb4d6c772a0da",
        runtime: "static-wasm",
        modelProtocol: "ai-sdk-language-model-v4",
        model: MODEL,
        aiGateway: "default",
        kernelDynamicWorkers: 0
      });
    }

    const [root, session] = url.pathname.split("/").filter(Boolean);
    if (root !== "sessions" || session === undefined) {
      return json({ error: "use /sessions/:session" }, { status: 404 });
    }
    return env.Coder.getByName(session).fetch(request);
  }
} satisfies ExportedHandler<Env>;
