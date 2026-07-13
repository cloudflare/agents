import { createEventBus, type EventBus } from "../../kernel/events.js";
import type { KeyValueStore } from "../../ports/storage.js";
import { createMemoryAlarmTimer, type MemoryAlarmTimer } from "./alarms.js";
import { createTestClock, type TestClock } from "./clock.js";
import { createMemoryConnectionRegistry, type MemoryConnectionRegistry } from "./transport.js";
import { createMemoryKeyValueStore } from "./store.js";

export interface MemoryHost {
  clock: TestClock;
  store: KeyValueStore;
  alarms: MemoryAlarmTimer;
  connections: MemoryConnectionRegistry;
  bus: EventBus;
  /**
   * Wires this host's alarm timer so that, when it fires, `agent.onAlarm()`
   * is invoked. The `AlarmTimer` port itself has no firing hook (a real
   * Durable Object delivers alarms via a platform callback, not via the
   * port) — this is the in-memory adapter's stand-in for that delivery
   * mechanism, mirroring how an adapter is expected to drive `onAlarm()`.
   */
  attachAgent(agent: { onAlarm(): void | Promise<void> }): void;
}

export interface CreateMemoryHostOptions {
  clock?: TestClock;
  agent?: string;
  name?: string;
}

/** Assembles a full in-memory port set: the shape every domain module and the app layer consume in tests. */
export function createMemoryHost(options: CreateMemoryHostOptions = {}): MemoryHost {
  const clock = options.clock ?? createTestClock();
  const store = createMemoryKeyValueStore();
  const alarms = createMemoryAlarmTimer(clock);
  const connections = createMemoryConnectionRegistry();
  const bus = createEventBus(
    { agent: options.agent ?? "Agent", name: options.name ?? "test" },
    () => clock.now()
  );

  return {
    clock,
    store,
    alarms,
    connections,
    bus,
    attachAgent(agent: { onAlarm(): void | Promise<void> }): void {
      alarms.onAlarm(() => agent.onAlarm());
    },
  };
}
