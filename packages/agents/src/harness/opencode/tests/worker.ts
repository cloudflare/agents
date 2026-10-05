import { DurableObject } from "cloudflare:workers";
import { OpenCodeHarness } from "..";
import { Lifecycle } from "../../../lifecycle";
import { createAI } from "../../../models/opencode";
import { Streams } from "../../../streams";

const LEASE_TTL_MS = 1_000;

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

function streamed(text: string): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  ];
  const body = [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
    .map((data) => `data: ${data}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" }
  });
}

function lastUserText(input: Record<string, unknown>): string {
  const messages = Array.isArray(input.messages)
    ? (input.messages as { role?: string; content?: unknown }[])
    : [];
  const last = messages.filter((message) => message.role === "user").at(-1);
  if (typeof last?.content === "string") return last.content;
  if (Array.isArray(last?.content)) {
    return (last.content as { text?: unknown }[])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function scriptedBinding(calls: string[]): Ai {
  return {
    aiGatewayLogId: null,
    async run(model: string, input: Record<string, unknown>) {
      calls.push(model);
      const prompt = lastUserText(input);
      if (prompt === "fail") {
        return Response.json(
          { errors: [{ message: "scripted failure" }] },
          { status: 400 }
        );
      }
      if (input.stream !== true) {
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "title" }
            }
          ]
        });
      }
      return streamed(`echo: ${prompt}`);
    }
  } as unknown as Ai;
}

export class OpenCodeHarnessTestObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    workerd: { models: { fetch: false } },
    lease: { ttlMs: LEASE_TTL_MS }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams);

  rootSession() {
    return this.harness.resolve(undefined);
  }

  async createSession() {
    return (await this.harness.sessions.create()).id;
  }

  listSessions() {
    return this.harness.sessions.list();
  }

  admitPrompt(session: string, operationId: string, text: string) {
    return this.harness.admitWithoutLease(session, operationId, text);
  }

  pending(session: string) {
    return this.harness.pending({ session });
  }

  async snapshot(session?: string) {
    const snapshot = await this.harness.snapshot(session ?? "root");
    return {
      session: snapshot.session,
      messages: snapshot.messages.length,
      running: snapshot.running
    };
  }

  leases() {
    return this.lifecycle.jobs
      .list()
      .filter((job) => job.fn === "lease")
      .map((job) => ({ id: job.id, payload: job.payload }));
  }

  dispose() {
    return this.lifecycle.dispose();
  }
}

export class OpenCodeModelTestObject extends DurableObject<Cloudflare.Env> {
  readonly calls: string[] = [];
  readonly ai = createAI({ binding: scriptedBinding(this.calls) });
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    workerd: { models: { fetch: false } },
    providers: [this.ai.provider],
    defaults: { model: this.ai(MODEL_ID) },
    lease: { ttlMs: LEASE_TTL_MS }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams);

  async prompt(text: string) {
    const { messages, ...result } = await this.harness.prompt(text);
    return { ...result, roles: messages.map((message) => message.role) };
  }

  submit(text: string, operationId?: string) {
    return this.harness.submit(text, operationId ? { operationId } : {});
  }

  wait(operationId: string) {
    return this.harness.wait(operationId);
  }

  async roles() {
    return (await this.harness.messages()).map((message) => message.role);
  }

  bindingCalls() {
    return [...this.calls];
  }

  async watch(text: string): Promise<string[]> {
    const stream = await this.harness.session().events();
    const types: string[] = [stream.snapshot.type];
    const ended = new Promise<void>((resolve) => {
      stream.start((events) => {
        for (const event of events) types.push(event.type);
        if (types.includes("text_delta") && types.includes("operation_end")) {
          resolve();
        }
      });
    });
    await this.harness.submit(text);
    await ended;
    await stream.stop();
    return types;
  }

  async api(path: string, init?: RequestInit) {
    const response = await this.harness.fetch(
      new Request(`http://opencode.local${path}`, init)
    );
    return { status: response.status, body: await response.text() };
  }

  leases() {
    return this.lifecycle.jobs.list().filter((job) => job.fn === "lease")
      .length;
  }

  dispose() {
    return this.lifecycle.dispose();
  }
}

export class OpenCodeSharedDatabaseTestObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    workerd: { models: { fetch: false } }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS vfs_files (path TEXT PRIMARY KEY)"
    );
  }

  async rootSession() {
    return this.harness.resolve(undefined);
  }

  tables() {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .toArray()
      .map((row) => row.name);
  }

  dispose() {
    return this.lifecycle.dispose();
  }
}

export class OpenCodeLeaseTestObject extends DurableObject<Cloudflare.Env> {}
