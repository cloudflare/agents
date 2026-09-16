import { Workspace } from "@cloudflare/shell";
import { Harness } from "@cloudflare/agents-next-harness";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { CodexRuntime } from "../codex-runtime";
import type { CodexProtocol } from "../protocol";
import { StressModel, type StressScenario } from "../stress/model";

/** One model round of tool calls, then one round of text. */
const SCENARIO: StressScenario = {
  rounds: 1,
  callsPerRound: 2,
  toolBytes: 64,
  answerBytes: 32,
  reasoningBytes: 16
};

const WAIT = { timeoutMs: 20_000 } as const;

/**
 * Real Durable Object fixture: the shipped Codex composition with the
 * scripted `StressModel` in place of Workers AI, so a test drives the real
 * Rust/Wasm kernel, the real Workspace tools and the real durable paths.
 */
export class CodexHarnessTestObject extends DurableObject<Env> {
  readonly model = new StressModel();
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex"
  });
  readonly codex = new CodexRuntime({
    sessions: this.sessions,
    workspace: this.workspace,
    model: this.model,
    compaction: false
  });
  readonly harness = new Harness<CodexProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.codex
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.harness);

  /** Prompt once and wait for the turn to settle. */
  async run(prompt: string, scenario: Partial<StressScenario> = {}) {
    await this.lifecycle.start();
    this.model.scenario = { ...SCENARIO, ...scenario };
    this.model.reset();
    const session = this.harness.session();
    const receipt = await session.prompt(prompt);
    const result = await session.wait(receipt.operationId, WAIT);
    return { receipt, result };
  }

  /** Admit a prompt without waiting for it: the turn runs on the driver. */
  async start(prompt: string, scenario: Partial<StressScenario> = {}) {
    await this.lifecycle.start();
    this.model.scenario = { ...SCENARIO, ...scenario };
    this.model.reset();
    return this.harness.session().prompt(prompt);
  }

  /** Wait for an operation admitted earlier, possibly by a lost incarnation. */
  async wait(operationId: string) {
    await this.lifecycle.start();
    return this.harness.session().wait(operationId, WAIT);
  }

  /** The transcript as the harness serves it: role and joined text. */
  async messages() {
    await this.lifecycle.start();
    const page = await this.harness.session().messages();
    return page.messages.map((message) => ({
      role: message.role,
      types: message.parts.map((part) => part.type),
      text: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
    }));
  }

  async status() {
    await this.lifecycle.start();
    return this.harness.session().status();
  }

  /** Replay the whole durable log, without tailing. */
  async eventTypes(from?: string) {
    await this.lifecycle.start();
    const types: string[] = [];
    const controller = new AbortController();
    for await (const event of this.harness.session().events({
      ...(from === undefined ? {} : { from }),
      signal: controller.signal,
      onUpToDate: () => controller.abort()
    })) {
      if ("preview" in event) continue;
      const body = event.body;
      types.push(
        body.type === "extension" ? `extension:${body.body.type}` : body.type
      );
    }
    return types;
  }

  /**
   * The kernel state the demo's operation route serves, flattened: the
   * checkpoint's own type is recursive JSON and does not need to cross RPC.
   */
  async kernel(operationId: string) {
    await this.lifecycle.start();
    const snapshot = this.codex.kernelSnapshot(operationId);
    return snapshot === null
      ? null
      : {
          phase: snapshot.checkpoint?.phase ?? null,
          modelRound: snapshot.checkpoint?.model_round ?? null,
          actionType: snapshot.action?.type ?? null,
          transitions: snapshot.transitions
        };
  }

  /** Read one file the tools wrote. */
  async file(path: string) {
    await this.lifecycle.start();
    return this.codex.readFile(path);
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
