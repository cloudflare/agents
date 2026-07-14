import { DurableObject } from "cloudflare:workers";
import {
  createDurableAlarmTimer,
  type DurableAlarmTimer
} from "../src/adapters/cloudflare/alarm.js";
import { hostAgent } from "../src/adapters/cloudflare/shell.js";
import { routeAgentRequest } from "../src/adapters/cloudflare/routing.js";
import { createFakeModel } from "../src/adapters/memory/fake-model.js";
import type { AgentHost } from "../src/app/agent.js";
import { Think } from "../src/app/think.js";
import type { ModelClient } from "../src/ports/model.js";

export class ScaffoldAgent extends DurableObject {
  override async fetch(): Promise<Response> {
    return new Response("scaffold");
  }
}

export class StoreTestAgent extends DurableObject<Cloudflare.Env> {
  private readonly timer: DurableAlarmTimer;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.timer = createDurableAlarmTimer({
      storage: ctx.storage,
      initial: null
    });
  }

  override async fetch(): Promise<Response> {
    return new Response("store-test");
  }

  armAlarm(at: number): Promise<void> {
    this.timer.set(at);
    return this.timer.flush();
  }

  readAlarm(): number | null {
    return this.timer.get();
  }

  clearAlarm(): Promise<void> {
    this.timer.clear();
    return this.timer.flush();
  }

  rearmOnNextAlarm(): void {
    this.ctx.storage.kv.put("alarm:rearm", true);
  }

  alarmFireCount(): number {
    return this.ctx.storage.kv.get<number>("alarm:count") ?? 0;
  }

  override async alarm(): Promise<void> {
    const firedAt = this.timer.onPlatformAlarm();
    const count = this.ctx.storage.kv.get<number>("alarm:count") ?? 0;
    this.ctx.storage.kv.put("alarm:count", count + 1);
    this.ctx.storage.kv.put("alarm:last", firedAt);

    const rearm = this.ctx.storage.kv.get<boolean>("alarm:rearm") ?? false;
    if (rearm) {
      this.ctx.storage.kv.put("alarm:rearm", false);
      this.timer.set((firedAt ?? Date.now()) + 1_000);
    }

    await this.timer.flush();
  }
}

export class FacetProbeChild extends DurableObject<Cloudflare.Env> {
  ping(): string {
    return "facet-pong";
  }

  async callFunctionArg(fn: (value: string) => string | Promise<string>): Promise<string> {
    return fn("from-child");
  }

  writeChildStorage(key: string, value: string): void {
    this.ctx.storage.kv.put(key, value);
  }

  readChildStorage(key: string): string | undefined {
    return this.ctx.storage.kv.get<string>(key);
  }

  async probeAlarm(at: number): Promise<{
    resolved: boolean;
    readBack: number | null;
    error?: string;
  }> {
    void at;
    return {
      resolved: false,
      readBack: await this.ctx.storage.getAlarm(),
      error: "facet child ctx.storage.setAlarm is unsafe in this runtime"
    };
  }
}

export class FacetProbeRoot extends DurableObject<Cloudflare.Env> {
  private child(name: string, withId = false): DurableObjectStub {
    return this.ctx.facets.get(name, () => ({
      class: this.ctx.exports.FacetProbeChild,
      ...(withId ? { id: this.ctx.id } : {})
    })) as DurableObjectStub;
  }

  async pingChild(name: string, withId = false): Promise<string> {
    const child = this.child(name, withId) as DurableObjectStub<FacetProbeChild>;
    return child.ping();
  }

  async callFunctionArg(name: string): Promise<string> {
    const child = this.child(name) as DurableObjectStub<FacetProbeChild>;
    return child.callFunctionArg((value: string) => `root-saw:${value}`);
  }

  async probeStorageIsolation(name: string): Promise<{
    childReadsRoot: string | null;
    rootReadsChild: string | null;
    childOwn: string | null;
    rootOwn: string | null;
  }> {
    const child = this.child(name) as DurableObjectStub<FacetProbeChild>;
    this.ctx.storage.kv.put("probe:root", "root-value");
    await child.writeChildStorage("probe:child", "child-value");
    return {
      childReadsRoot: (await child.readChildStorage("probe:root")) ?? null,
      rootReadsChild: this.ctx.storage.kv.get<string>("probe:child") ?? null,
      childOwn: (await child.readChildStorage("probe:child")) ?? null,
      rootOwn: this.ctx.storage.kv.get<string>("probe:root") ?? null
    };
  }

  async probeChildAlarm(name: string, at: number): Promise<{
    resolved: boolean;
    readBack: number | null;
    error?: string;
  }> {
    const child = this.child(name) as DurableObjectStub<FacetProbeChild>;
    return child.probeAlarm(at);
  }
}

export class ChatAgent extends Think<{ count: number }> {
  private readonly model = createFakeModel((_request, call) => ({
    kind: "text",
    text: `worker response ${call + 1}`
  }));

  protected override getInitialState(): { count: number } {
    return { count: 0 };
  }

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getSystemPrompt(): string {
    return "You are a test worker chat agent.";
  }

  noteFired(): void {
    const count = this.host.store.get<number>("test:note-fired-count") ?? 0;
    this.host.store.put("test:note-fired-count", count + 1);
  }
}

export class ChildAgent extends Think {
  private readonly instanceId = crypto.randomUUID();
  private readonly model = createFakeModel((request) => {
    const text = request.messages
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
          : [message.content]
      )
      .join(" ");
    return { kind: "text", text: `child:${text}` };
  });

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getSystemPrompt(): string {
    return "You are a child test agent.";
  }

  childNoteFired(): void {
    const count = this.host.store.get<number>("test:child-note-fired") ?? 0;
    this.host.store.put("test:child-note-fired", count + 1);
  }

  inspectRun(command?: {
    op:
      | "put"
      | "get"
      | "instanceId"
      | "parentPath"
      | "scheduleNote"
      | "makeNoteDue"
      | "noteFiredCount";
    key?: string;
    value?: unknown;
  }): unknown {
    if (!command) {
      return {
        status: "completed",
        output: {
          instanceId: this.instanceId,
          parentPath: this.parentPath(),
          selfPath: this.selfPath()
        }
      };
    }
    if (command.op === "put") {
      if (!command.key) throw new Error("key required");
      this.host.store.put(command.key, command.value);
      return { ok: true };
    }
    if (command.op === "get") {
      if (!command.key) throw new Error("key required");
      return this.host.store.get(command.key) ?? null;
    }
    if (command.op === "instanceId") {
      return this.instanceId;
    }
    if (command.op === "parentPath") {
      return this.parentPath();
    }
    if (command.op === "scheduleNote") {
      const schedule = this.schedule(1, "childNoteFired", {});
      return schedule.nextRunAt;
    }
    if (command.op === "makeNoteDue") {
      const [note] = this.listSchedules({ callback: "childNoteFired" });
      if (!note) throw new Error("No child note to make due");
      const msUntilDue = note.nextRunAt - this.host.clock.now();
      if (msUntilDue >= 0) advanceChildTestClock(this.name, msUntilDue + 1);
      return note.nextRunAt;
    }
    if (command.op === "noteFiredCount") {
      return this.host.store.get<number>("test:child-note-fired") ?? 0;
    }
    return null;
  }
}

const chatClockOffsets = new Map<string, number>();
const childClockOffsets = new Map<string, number>();

function chatTestClock(host: AgentHost): AgentHost["clock"] {
  return {
    now: () => Date.now() + (chatClockOffsets.get(host.name) ?? 0)
  };
}

function childTestClock(host: AgentHost): AgentHost["clock"] {
  return {
    now: () => Date.now() + (childClockOffsets.get(host.name) ?? 0)
  };
}

function advanceChatTestClock(name: string, ms: number): void {
  chatClockOffsets.set(name, (chatClockOffsets.get(name) ?? 0) + ms);
}

function advanceChildTestClock(name: string, ms: number): void {
  childClockOffsets.set(name, (childClockOffsets.get(name) ?? 0) + ms);
}

const HostedChatAgentDO = hostAgent(ChatAgent, {
  create: (host) => new ChatAgent({ ...host, clock: chatTestClock(host) })
});

const HostedChildAgentDO = hostAgent(ChildAgent, {
  create: (host) => new ChildAgent({ ...host, clock: childTestClock(host) })
});

export class ChildAgentDO extends HostedChildAgentDO {}

export class ChatAgentDO extends HostedChatAgentDO {
  async scheduleNote(): Promise<void> {
    await this.withAgent((agent) => {
      agent.schedule(1, "noteFired", {});
    });
    await this.flushAlarm();
  }

  makeScheduledNoteDue(): Promise<void> {
    return this.withAgent((agent) => {
      const [note] = agent.listSchedules({ callback: "noteFired" });
      if (!note) throw new Error("No scheduled note to make due");

      const msUntilDue = note.nextRunAt - agent.host.clock.now();
      if (msUntilDue >= 0) advanceChatTestClock(agent.name, msUntilDue + 1);
    });
  }

  noteFiredCount(): Promise<number> {
    return this.withAgent(
      (agent) => agent.host.store.get<number>("test:note-fired-count") ?? 0
    );
  }

  async childInspect(name: string, command?: Parameters<ChildAgent["inspectRun"]>[0]): Promise<unknown> {
    const result = await this.withAgent((agent) =>
      agent.subAgent("ChildAgentDO", name).call("inspectRun", command === undefined ? [] : [command])
    );
    await this.flushAlarm();
    return result;
  }

  async childCall(name: string, method: string, args: unknown[] = []): Promise<unknown> {
    const result = await this.withAgent((agent) =>
      agent.subAgent("ChildAgentDO", name).call(method, args)
    );
    await this.flushAlarm();
    return result;
  }

  async childCallOutcome(name: string, method: string, args: unknown[] = []): Promise<{
    ok: true;
    result: unknown;
  } | {
    ok: false;
    error: string;
  }> {
    try {
      return { ok: true, result: await this.childCall(name, method, args) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  abortChild(name: string, reason?: unknown): Promise<void> {
    return this.withAgent((agent) => {
      agent.abortSubAgent("ChildAgentDO", name, reason);
    });
  }

  destroyChild(name: string): Promise<void> {
    return this.withAgent((agent) =>
      agent.deleteSubAgent("ChildAgentDO", name)
    );
  }

  async childChatEvents(name: string, prompt: string): Promise<unknown[]> {
    const events = await this.withAgent(async (agent) => {
      const events: unknown[] = [];
      await agent.subAgent("ChildAgentDO", name).call("chat", [
        prompt,
        {
          onStart: (info: unknown) => events.push({ type: "start", info }),
          onEvent: (event: unknown) => events.push(event),
          onDone: () => events.push({ type: "done" }),
          onError: (err: unknown) => events.push({ type: "error", err })
        }
      ]);
      return events;
    });
    await this.flushAlarm();
    return events;
  }

  async scheduleRootNote(seconds: number): Promise<number> {
    const nextRunAt = await this.withAgent((agent) => {
      const schedule = agent.schedule(seconds, "noteFired", {});
      return schedule.nextRunAt;
    });
    await this.flushAlarm();
    return nextRunAt;
  }

  readPlatformAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return (
      (await routeAgentRequest(
        request,
        env as unknown as Record<string, unknown>
      )) ?? new Response("rebuild test worker")
    );
  }
};
