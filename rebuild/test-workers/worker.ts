import { DurableObject } from "cloudflare:workers";
import {
  createDurableAlarmTimer,
  type DurableAlarmTimer,
} from "../src/adapters/cloudflare/alarm.js";

export class ScaffoldAgent extends DurableObject {
  override async fetch(): Promise<Response> {
    return new Response("scaffold");
  }
}

export class StoreTestAgent extends DurableObject<Cloudflare.Env> {
  private readonly timer: DurableAlarmTimer;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.timer = createDurableAlarmTimer({ storage: ctx.storage, initial: null });
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

export default {
  async fetch(): Promise<Response> {
    return new Response("rebuild test worker");
  },
};
