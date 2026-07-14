import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StoreTestAgent } from "./worker.js";

let alarmCounter = 0;

function futureAlarmTime(): number {
  return Date.now() + 60_000;
}

function freshStub(): DurableObjectStub {
  const id = env.STORE_TEST_AGENT.idFromName(`alarm-${alarmCounter++}`);
  return env.STORE_TEST_AGENT.get(id);
}

describe("createDurableAlarmTimer", () => {
  it("set then get agrees", async () => {
    const stub = freshStub();
    const alarmAt = futureAlarmTime();

    await runInDurableObject(stub, (instance) => {
      const agent = instance as StoreTestAgent;
      const armed = agent.armAlarm(alarmAt);
      expect(agent.readAlarm()).toBe(alarmAt);
      return armed;
    });
  });

  it("platform alarm fires the handler and clears the mirror", async () => {
    const stub = freshStub();
    const alarmAt = futureAlarmTime();

    await runInDurableObject(stub, (instance) =>
      (instance as StoreTestAgent).armAlarm(alarmAt)
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (instance) => {
      const agent = instance as StoreTestAgent;
      expect(agent.alarmFireCount()).toBe(1);
      expect(agent.readAlarm()).toBeNull();
    });
  });

  it("re-arming from inside the handler schedules another platform alarm", async () => {
    const stub = freshStub();
    const alarmAt = futureAlarmTime();

    await runInDurableObject(stub, (instance) => {
      const agent = instance as StoreTestAgent;
      agent.rearmOnNextAlarm();
      return agent.armAlarm(alarmAt);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (instance) => {
      expect((instance as StoreTestAgent).alarmFireCount()).toBe(2);
    });
  });

  it("clear prevents a platform alarm from firing", async () => {
    const stub = freshStub();
    const alarmAt = futureAlarmTime();

    await runInDurableObject(stub, (instance) => {
      const agent = instance as StoreTestAgent;
      void agent.armAlarm(alarmAt);
      return agent.clearAlarm();
    });

    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});
