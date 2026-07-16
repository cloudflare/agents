import { Think, hostAgent } from "../compat.js";

type OriginalScheduleType = "scheduled" | "delayed" | "cron" | "interval";

type P12Schedule = {
  id: string;
  callback: string;
  payload: unknown;
  type: OriginalScheduleType;
  time?: number;
  delayInSeconds?: number;
  intervalSeconds?: number;
  cron?: string;
  retry?: unknown;
};

const KIND_PREFIX = "p12:schedule-kind:";

function unsupportedIdempotentOption(value: boolean): unknown {
  return { idempotent: value };
}

class TestP12ScheduleAgentImpl extends Think {
  intervalCallbackCount = 0;

  testCallback(): void {}

  cronCallback(): void {}

  intervalCallback(): void {
    this.intervalCallbackCount += 1;
  }

  secondIntervalCallback(): void {}

  throwingCallback(): void {
    throw new Error("Intentional test error");
  }

  private rememberKind(id: string, type: OriginalScheduleType): void {
    this.host.store.put(`${KIND_PREFIX}${id}`, type);
  }

  private originalTypeFor(schedule: {
    id: string;
    spec: { kind: string; everySeconds?: number; expression?: string };
  }): OriginalScheduleType {
    return (
      this.host.store.get<OriginalScheduleType>(
        `${KIND_PREFIX}${schedule.id}`
      ) ??
      (schedule.spec.kind === "interval"
        ? "interval"
        : schedule.spec.kind === "cron"
          ? "cron"
          : "delayed")
    );
  }

  private toOriginalShape(schedule: {
    id: string;
    callback: string;
    payload: unknown;
    spec: {
      kind: string;
      at?: number;
      everySeconds?: number;
      expression?: string;
    };
    nextRunAt: number;
    retry?: unknown;
  }): P12Schedule {
    const type = this.originalTypeFor(schedule);
    return {
      id: schedule.id,
      callback: schedule.callback,
      payload: schedule.payload,
      type,
      time: Math.floor(schedule.nextRunAt / 1000),
      ...(type === "delayed" ? { delayInSeconds: undefined } : {}),
      ...(type === "interval"
        ? { intervalSeconds: schedule.spec.everySeconds }
        : {}),
      ...(type === "cron" ? { cron: schedule.spec.expression } : {}),
      ...(schedule.retry !== undefined ? { retry: schedule.retry } : {})
    };
  }

  cancelScheduleById(id: string): boolean {
    return this.cancelSchedule(id);
  }

  getStoredScheduleById(id: string): P12Schedule | undefined {
    const schedule = this.getScheduleById(id);
    return schedule ? this.toOriginalShape(schedule) : undefined;
  }

  getSchedulesByType(type: OriginalScheduleType): P12Schedule[] {
    return this.listSchedules()
      .map((schedule) => this.toOriginalShape(schedule))
      .filter((schedule) => schedule.type === type);
  }

  getScheduleCount(): number {
    return this.listSchedules().length;
  }

  getScheduleCountByTypeAndCallback(
    type: OriginalScheduleType,
    callback: string
  ): number {
    return this.getSchedulesByType(type).filter(
      (schedule) => schedule.callback === callback
    ).length;
  }

  createSchedule(delaySeconds: number): string {
    const schedule = this.schedule(delaySeconds, "testCallback");
    this.rememberKind(schedule.id, "delayed");
    return schedule.id;
  }

  createIntervalSchedule(intervalSeconds: number): string {
    const schedule = this.scheduleEvery(intervalSeconds, "intervalCallback");
    this.rememberKind(schedule.id, "interval");
    return schedule.id;
  }

  createIntervalScheduleWithPayload(
    intervalSeconds: number,
    payload: string
  ): string {
    const schedule = this.scheduleEvery(
      intervalSeconds,
      "intervalCallback",
      payload
    );
    this.rememberKind(schedule.id, "interval");
    return schedule.id;
  }

  createSecondIntervalSchedule(intervalSeconds: number): string {
    const schedule = this.scheduleEvery(
      intervalSeconds,
      "secondIntervalCallback"
    );
    this.rememberKind(schedule.id, "interval");
    return schedule.id;
  }

  createThrowingIntervalSchedule(intervalSeconds: number): string {
    const schedule = this.scheduleEvery(intervalSeconds, "throwingCallback");
    this.rememberKind(schedule.id, "interval");
    return schedule.id;
  }

  createCronSchedule(cronExpr: string): string {
    const schedule = this.schedule(cronExpr, "cronCallback");
    this.rememberKind(schedule.id, "cron");
    return schedule.id;
  }

  createCronScheduleWithPayload(cronExpr: string, payload: string): string {
    const schedule = this.schedule(cronExpr, "cronCallback", payload);
    this.rememberKind(schedule.id, "cron");
    return schedule.id;
  }

  createCronScheduleNonIdempotent(cronExpr: string): string {
    const schedule = this.schedule(
      cronExpr,
      "cronCallback",
      undefined,
      unsupportedIdempotentOption(false) as { id?: string }
    );
    this.rememberKind(schedule.id, "cron");
    return schedule.id;
  }

  createIdempotentDelayedSchedule(delaySeconds: number): string {
    const schedule = this.schedule(
      delaySeconds,
      "testCallback",
      undefined,
      unsupportedIdempotentOption(true) as { id?: string }
    );
    this.rememberKind(schedule.id, "delayed");
    return schedule.id;
  }

  createIdempotentDelayedScheduleWithPayload(
    delaySeconds: number,
    payload: string
  ): string {
    const schedule = this.schedule(
      delaySeconds,
      "testCallback",
      payload,
      unsupportedIdempotentOption(true) as { id?: string }
    );
    this.rememberKind(schedule.id, "delayed");
    return schedule.id;
  }

  createIdempotentScheduledSchedule(dateMs: number): string {
    const schedule = this.schedule(
      new Date(dateMs),
      "testCallback",
      undefined,
      unsupportedIdempotentOption(true) as { id?: string }
    );
    this.rememberKind(schedule.id, "scheduled");
    return schedule.id;
  }

  createIntervalScheduleAndReadAlarm(intervalSeconds: number): {
    alarm: number | null;
    id: string;
  } {
    const id = this.createIntervalSchedule(intervalSeconds);
    return { alarm: this.host.alarm.get(), id };
  }

  clearStoredAlarm(): void {
    this.host.alarm.clear();
  }

  getStoredAlarm(): number | null {
    return this.host.alarm.get();
  }

  setStoredAlarm(timeMs: number): void {
    this.host.alarm.set(timeMs);
  }

  scheduleFarFutureTask(delaySeconds: number): void {
    const schedule = this.schedule(delaySeconds, "testCallback");
    this.rememberKind(schedule.id, "delayed");
  }
}

class TestP12OnStartScheduleWarnAgentImpl extends TestP12ScheduleAgentImpl {
  protected override async onStart(): Promise<void> {
    this.schedule(60, "testCallback");
  }

  wasWarnedFor(_callback: string): boolean {
    return false;
  }
}

class TestP12OnStartScheduleExplicitFalseAgentImpl extends TestP12ScheduleAgentImpl {
  protected override async onStart(): Promise<void> {
    this.schedule(
      60,
      "testCallback",
      undefined,
      unsupportedIdempotentOption(false) as { id?: string }
    );
  }

  wasWarnedFor(_callback: string): boolean {
    return false;
  }
}

class TestP12OnStartScheduleNoWarnAgentImpl extends TestP12ScheduleAgentImpl {
  protected override async onStart(): Promise<void> {
    this.schedule(
      60,
      "testCallback",
      undefined,
      unsupportedIdempotentOption(true) as { id?: string }
    );
  }

  wasWarnedFor(_callback: string): boolean {
    return false;
  }
}

class TestP12KeepAliveAgentImpl extends Think {
  private keepAliveDisposers: Array<() => void> = [];

  startKeepAlive(): string {
    const dispose = this.keepAlive();
    this.keepAliveDisposers.push(dispose);
    return "started";
  }

  stopKeepAlive(): string {
    const dispose = this.keepAliveDisposers.pop();
    dispose?.();
    return "stopped";
  }

  runWithKeepAliveWhile(): Promise<string> {
    return this.keepAliveWhile(async () => "completed");
  }

  async runWithKeepAliveWhileError(): Promise<string> {
    try {
      await this.keepAliveWhile(async () => {
        throw new Error("task failed");
      });
      return "should not reach";
    } catch {
      return "caught";
    }
  }

  getScheduleCount(): number {
    return this.listSchedules().length;
  }

  getCurrentAlarm(): number | null {
    return this.host.alarm.get();
  }

  scheduleFarFutureTask(delaySeconds: number): void {
    this.schedule(delaySeconds, "noop");
  }

  noop(): void {}
}

const TestP12ScheduleAgentBase = hostAgent(TestP12ScheduleAgentImpl);
const TestP12OnStartScheduleWarnAgentBase = hostAgent(
  TestP12OnStartScheduleWarnAgentImpl
);
const TestP12OnStartScheduleExplicitFalseAgentBase = hostAgent(
  TestP12OnStartScheduleExplicitFalseAgentImpl
);
const TestP12OnStartScheduleNoWarnAgentBase = hostAgent(
  TestP12OnStartScheduleNoWarnAgentImpl
);
const TestP12KeepAliveAgentBase = hostAgent(TestP12KeepAliveAgentImpl);

export class TestP12ScheduleAgent extends TestP12ScheduleAgentBase {
  cancelScheduleById(id: string): Promise<boolean> {
    return this.withAgent((agent) => agent.cancelScheduleById(id));
  }

  getStoredScheduleById(id: string): Promise<P12Schedule | undefined> {
    return this.withAgent((agent) => agent.getStoredScheduleById(id));
  }

  getSchedulesByType(type: OriginalScheduleType): Promise<P12Schedule[]> {
    return this.withAgent((agent) => agent.getSchedulesByType(type));
  }

  getScheduleCount(): Promise<number> {
    return this.withAgent((agent) => agent.getScheduleCount());
  }

  getScheduleCountByTypeAndCallback(
    type: OriginalScheduleType,
    callback: string
  ): Promise<number> {
    return this.withAgent((agent) =>
      agent.getScheduleCountByTypeAndCallback(type, callback)
    );
  }

  createSchedule(delaySeconds: number): Promise<string> {
    return this.withAgent((agent) => agent.createSchedule(delaySeconds));
  }

  createIntervalSchedule(intervalSeconds: number): Promise<string> {
    return this.withAgent((agent) =>
      agent.createIntervalSchedule(intervalSeconds)
    );
  }

  createIntervalScheduleWithPayload(
    intervalSeconds: number,
    payload: string
  ): Promise<string> {
    return this.withAgent((agent) =>
      agent.createIntervalScheduleWithPayload(intervalSeconds, payload)
    );
  }

  createSecondIntervalSchedule(intervalSeconds: number): Promise<string> {
    return this.withAgent((agent) =>
      agent.createSecondIntervalSchedule(intervalSeconds)
    );
  }

  createThrowingIntervalSchedule(intervalSeconds: number): Promise<string> {
    return this.withAgent((agent) =>
      agent.createThrowingIntervalSchedule(intervalSeconds)
    );
  }

  createCronSchedule(cronExpr: string): Promise<string> {
    return this.withAgent((agent) => agent.createCronSchedule(cronExpr));
  }

  createCronScheduleWithPayload(
    cronExpr: string,
    payload: string
  ): Promise<string> {
    return this.withAgent((agent) =>
      agent.createCronScheduleWithPayload(cronExpr, payload)
    );
  }

  createCronScheduleNonIdempotent(cronExpr: string): Promise<string> {
    return this.withAgent((agent) =>
      agent.createCronScheduleNonIdempotent(cronExpr)
    );
  }

  createIdempotentDelayedSchedule(delaySeconds: number): Promise<string> {
    return this.withAgent((agent) =>
      agent.createIdempotentDelayedSchedule(delaySeconds)
    );
  }

  createIdempotentDelayedScheduleWithPayload(
    delaySeconds: number,
    payload: string
  ): Promise<string> {
    return this.withAgent((agent) =>
      agent.createIdempotentDelayedScheduleWithPayload(delaySeconds, payload)
    );
  }

  createIdempotentScheduledSchedule(dateMs: number): Promise<string> {
    return this.withAgent((agent) =>
      agent.createIdempotentScheduledSchedule(dateMs)
    );
  }

  createIntervalScheduleAndReadAlarm(
    intervalSeconds: number
  ): Promise<{ alarm: number | null; id: string }> {
    return this.withAgent((agent) =>
      agent.createIntervalScheduleAndReadAlarm(intervalSeconds)
    );
  }

  clearStoredAlarm(): Promise<void> {
    return this.withAgent((agent) => agent.clearStoredAlarm());
  }

  getStoredAlarm(): Promise<number | null> {
    return this.withAgent((agent) => agent.getStoredAlarm());
  }

  setStoredAlarm(timeMs: number): Promise<void> {
    return this.withAgent((agent) => agent.setStoredAlarm(timeMs));
  }

  scheduleFarFutureTask(delaySeconds: number): Promise<void> {
    return this.withAgent((agent) => agent.scheduleFarFutureTask(delaySeconds));
  }
}

export class TestP12OnStartScheduleWarnAgent extends TestP12OnStartScheduleWarnAgentBase {
  wasWarnedFor(callback: string): Promise<boolean> {
    return this.withAgent((agent) => agent.wasWarnedFor(callback));
  }

  getScheduleCount(): Promise<number> {
    return this.withAgent((agent) => agent.getScheduleCount());
  }
}

export class TestP12OnStartScheduleExplicitFalseAgent extends TestP12OnStartScheduleExplicitFalseAgentBase {
  wasWarnedFor(callback: string): Promise<boolean> {
    return this.withAgent((agent) => agent.wasWarnedFor(callback));
  }
}

export class TestP12OnStartScheduleNoWarnAgent extends TestP12OnStartScheduleNoWarnAgentBase {
  wasWarnedFor(callback: string): Promise<boolean> {
    return this.withAgent((agent) => agent.wasWarnedFor(callback));
  }

  getScheduleCount(): Promise<number> {
    return this.withAgent((agent) => agent.getScheduleCount());
  }
}

export class TestP12KeepAliveAgent extends TestP12KeepAliveAgentBase {
  startKeepAlive(): Promise<string> {
    return this.withAgent((agent) => agent.startKeepAlive());
  }

  stopKeepAlive(): Promise<string> {
    return this.withAgent((agent) => agent.stopKeepAlive());
  }

  runWithKeepAliveWhile(): Promise<string> {
    return this.withAgent((agent) => agent.runWithKeepAliveWhile());
  }

  runWithKeepAliveWhileError(): Promise<string> {
    return this.withAgent((agent) => agent.runWithKeepAliveWhileError());
  }

  getScheduleCount(): Promise<number> {
    return this.withAgent((agent) => agent.getScheduleCount());
  }

  getCurrentAlarm(): Promise<number | null> {
    return this.withAgent((agent) => agent.getCurrentAlarm());
  }

  scheduleFarFutureTask(delaySeconds: number): Promise<void> {
    return this.withAgent((agent) => agent.scheduleFarFutureTask(delaySeconds));
  }
}
