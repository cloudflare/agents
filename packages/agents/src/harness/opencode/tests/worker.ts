import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { createAI } from "../../../models/opencode";
import { setWakeTimingForTests } from "../harness";
import { prefixTables } from "../../table-prefix";
import {
  OpenCodeHarness,
  type OpenCodeMessage,
  type OpenCodeOperationResult,
  type OpenCodeReceipt,
  type OpenCodeWhenBusy
} from "../index";
import { scriptedAI } from "./scripted-ai";
import { TEST_TIMING } from "./timing";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";
const RELEASE_KEY = "test:hold:release";
const HOLD_RUNS_KEY = "test:hold:runs";

/** User and assistant texts, so tests can compare transcripts as strings. */
function texts(messages: readonly OpenCodeMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.type === "user") return [message.text];
    if (message.type === "assistant") {
      return [
        message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
      ];
    }
    return [];
  });
}

/** A real Durable Object: OpenCode over a scripted Workers AI binding. */
export class OpenCodeHarnessTestObject extends DurableObject<Cloudflare.Env> {
  readonly ai = createAI({
    binding: scriptedAI((signal) => this.#hold(signal)).binding
  });
  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        storage,
        models: { fetch: false },
        plugins: [this.ai.plugin]
      }),
    defaults: { model: this.ai(MODEL) }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    setWakeTimingForTests(this.harness, TEST_TIMING);
    // A host table named like one of OpenCode's.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY)"
    );
  }

  async #hold(signal: AbortSignal | undefined): Promise<void> {
    const runs = ((await this.ctx.storage.get<number>(HOLD_RUNS_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(HOLD_RUNS_KEY, runs);
    while (!(await this.ctx.storage.get<boolean>(RELEASE_KEY))) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async prompt(text: string, session?: string) {
    const response = await this.harness.prompt(
      text,
      session ? { session } : {}
    );
    return { ...response, messages: texts(response.messages) };
  }

  submit(
    text: string,
    options: {
      whenBusy?: OpenCodeWhenBusy;
      session?: string;
      operationId?: string;
    } = {}
  ): Promise<OpenCodeReceipt> {
    return this.harness.submit(text, options);
  }

  wait(
    operationId: string,
    session?: string
  ): Promise<OpenCodeOperationResult> {
    return this.harness.wait(operationId, session ? { session } : {});
  }

  async messages(session?: string): Promise<string[]> {
    return texts(await this.harness.messages(session ? { session } : {}));
  }

  async history(session?: string): Promise<string[]> {
    return texts(await this.harness.session(session).history());
  }

  pending() {
    return this.harness.pending();
  }

  abort(operationId?: string): Promise<boolean> {
    return this.harness.abort(operationId ? { operationId } : {});
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  async forkSession(from: string): Promise<string> {
    return (await this.harness.sessions.fork(from)).id;
  }

  listSessions() {
    return this.harness.sessions.list();
  }

  /** Resolve once the held model call has started `runs` times. */
  async holdStarted(runs: number): Promise<number> {
    for (let i = 0; i < 500; i++) {
      const count = (await this.ctx.storage.get<number>(HOLD_RUNS_KEY)) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The held model call never started");
  }

  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }

  async holdRuns(): Promise<number> {
    return (await this.ctx.storage.get<number>(HOLD_RUNS_KEY)) ?? 0;
  }

  /** Watch the root session's events until its run is idle again. */
  async watch(text: string): Promise<string[]> {
    const controller = new AbortController();
    const types: string[] = [];
    const session = this.harness.session();
    const watching = (async () => {
      for await (const event of session.events(controller.signal)) {
        types.push(event.type);
        if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed"
        ) {
          return;
        }
      }
    })();
    // Let the subscription attach before the run starts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.submit(text);
    await watching;
    controller.abort();
    return types;
  }

  /** The durable log's event types for the root session. */
  async logTypes(): Promise<string[]> {
    const types: string[] = [];
    for await (const event of this.harness.session().log()) {
      types.push(event.type);
    }
    return types;
  }

  /** Every table and index name in the object's database. */
  tables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .toArray()
      .map((row) => row.name);
  }

  alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };

/** A bare object for `prefixTables`, over its own SQLite database. */
export class TablePrefixTestObject extends DurableObject<Cloudflare.Env> {
  readonly #prefixed = prefixTables(this.ctx.storage, "engine_");

  /**
   * Run statements through the prefixed view; return the last one's rows.
   * A statement is its SQL, or its SQL followed by its bindings.
   */
  prefixed(
    statements: readonly (string | readonly [string, ...SqlStorageValue[]])[]
  ): Record<string, SqlStorageValue>[] {
    let rows: Record<string, SqlStorageValue>[] = [];
    for (const statement of statements) {
      const [sql, ...bindings] =
        typeof statement === "string" ? [statement] : statement;
      rows = this.#prefixed.sql.exec(sql, ...bindings).toArray();
    }
    return rows;
  }

  /** Run a statement on the real database. */
  raw(statement: string): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql.exec(statement).toArray();
  }

  /** Every table and index, by its real name. */
  objects(): string[] {
    return this.raw(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    ).map((row) => String(row.name));
  }
}
