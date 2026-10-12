import type { Plugin } from "@opencode/plugin";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { createAI } from "../../../models/opencode";
import { setWakeTimingForTests } from "../harness";
import { prefixTables } from "../../table-prefix";
import {
  OpenCodeHarness,
  type OpenCodeEventStream,
  type OpenCodeMessage,
  type OpenCodeOperationResult,
  type OpenCodeReceipt,
  type OpenCodeSessionEvent,
  type OpenCodeSessionSnapshot,
  type OpenCodeWhenBusy
} from "../index";
import { scriptedAI } from "./scripted-ai";
import { TEST_TIMING } from "./timing";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";
const RELEASE_KEY = "test:hold:release";
const HOLD_RUNS_KEY = "test:hold:runs";

/** A tool the scripted model calls: it upper-cases its input. */
const shoutPlugin: Plugin.Plugin = {
  id: "test.shout",
  async setup(context) {
    await context.tool.transform((editor) => {
      editor.add({
        name: "shout",
        description: "Upper-case some text.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        },
        // Offered to the model by name, not inside OpenCode's code mode.
        options: { codemode: false },
        execute: async (input) => ({
          content: (input as { text: string }).text.toUpperCase()
        })
      });
    });
  }
};

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
        plugins: [this.ai.plugin, shoutPlugin]
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

  /** Open streams, by id, for tests that read events in steps. */
  readonly #streams = new Map<
    string,
    { stream: OpenCodeEventStream; events: OpenCodeSessionEvent[] }
  >();

  /**
   * Open the root session's event stream; returns its id and its snapshot,
   * with the transcript as texts. OpenCode's message type is too deep for
   * the stub's RPC types.
   */
  async openStream(): Promise<{
    id: string;
    snapshot: Omit<OpenCodeSessionSnapshot, "messages"> & {
      readonly messages: string[];
    };
  }> {
    const stream = await this.harness.session().events();
    const id = crypto.randomUUID();
    const events: OpenCodeSessionEvent[] = [];
    stream.start((batch) => events.push(...batch));
    this.#streams.set(id, { stream, events });
    return {
      id,
      snapshot: {
        ...stream.snapshot,
        messages: texts(stream.snapshot.messages)
      }
    };
  }

  /**
   * The stream's events once one of type `until` has arrived `count`
   * times; then stop the stream.
   */
  async drain(
    id: string,
    until: OpenCodeSessionEvent["type"],
    count = 1
  ): Promise<OpenCodeSessionEvent[]> {
    const open = this.#streams.get(id);
    if (open === undefined) throw new Error(`No stream ${id}`);
    for (let i = 0; i < 500; i++) {
      if (open.events.filter((event) => event.type === until).length >= count) {
        await open.stream.stop();
        this.#streams.delete(id);
        return open.events;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await open.stream.stop();
    this.#streams.delete(id);
    throw new Error(
      `No ${until} event; got ${open.events.map((event) => event.type).join(", ")}`
    );
  }

  /**
   * Open a stream, let a run fill its buffer, stop it, then start it:
   * returns how many events reached the listener.
   */
  async startAfterStop(): Promise<number> {
    const stream = await this.harness.session().events();
    const receipt = await this.harness.submit("hello");
    await this.harness.wait(receipt.operationId);
    await stream.stop();
    let delivered = 0;
    stream.start((events) => {
      delivered += events.length;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return delivered;
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
