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

const chatClockOffsets = new Map<string, number>();

function chatTestClock(host: AgentHost): AgentHost["clock"] {
  return {
    now: () => Date.now() + (chatClockOffsets.get(host.name) ?? 0)
  };
}

function advanceChatTestClock(name: string, ms: number): void {
  chatClockOffsets.set(name, (chatClockOffsets.get(name) ?? 0) + ms);
}

const HostedChatAgentDO = hostAgent(ChatAgent, {
  create: (host) => new ChatAgent({ ...host, clock: chatTestClock(host) })
});

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
