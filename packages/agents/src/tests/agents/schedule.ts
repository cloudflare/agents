import { Agent, callable } from "../../index.ts";

/**
 * Test agent that verifies this.name is accessible during scheduled callback
 * execution. This catches the bug where Agent.alarm() bypassed PartyServer's
 * #ensureInitialized(), causing this.name to throw when accessed in alarm-triggered
 * callbacks.
 */
export class TestAlarmInitAgent extends Agent {
  // Track the name captured during callback execution
  _capturedName: string | null = null;
  _onStartCalled = false;
  _callbackError: string | null = null;

  async onStart() {
    this._onStartCalled = true;
  }

  // Callback that reads this.name — would throw before the fix if
  // #ensureInitialized() hadn't run
  nameCheckCallback() {
    try {
      this._capturedName = this.name;
    } catch (e) {
      this._callbackError = e instanceof Error ? e.message : String(e);
    }
  }

  async scheduleNameCheck(delaySeconds: number): Promise<string> {
    const schedule = await this.schedule(delaySeconds, "nameCheckCallback");
    return schedule.id;
  }

  @callable()
  async clearStoredAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  @callable()
  async setStoredAlarm(timeMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(timeMs);
  }
}

export class TestDestroyScheduleAgent extends Agent<
  Cloudflare.Env,
  { status: string }
> {
  initialState = {
    status: "unscheduled"
  };

  async scheduleSelfDestructingAlarm(delaySeconds = 86400): Promise<string> {
    this.setState({ status: "scheduled" });
    await this.schedule(delaySeconds, "destroy");
    return this.state.status;
  }

  getStatus() {
    return this.state.status;
  }
}

/**
 * Agent that calls schedule() in onStart() without idempotent — should warn.
 */
export class TestOnStartScheduleWarnAgent extends Agent {
  maintenanceCallback() {
    // no-op
  }

  async onStart() {
    await this.schedule(60, "maintenanceCallback");
  }

  @callable()
  wasWarnedFor(cb: string): boolean {
    return (
      this as unknown as { _warnedScheduleInOnStart: Set<string> }
    )._warnedScheduleInOnStart.has(cb);
  }

  @callable()
  async getScheduleCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
    `;
    return result[0].count;
  }
}

/**
 * Agent that calls schedule() in onStart() WITH idempotent — should not warn.
 */
export class TestOnStartScheduleNoWarnAgent extends Agent {
  maintenanceCallback() {
    // no-op
  }

  async onStart() {
    await this.schedule(60, "maintenanceCallback", undefined, {
      idempotent: true
    });
  }

  @callable()
  wasWarnedFor(cb: string): boolean {
    return (
      this as unknown as { _warnedScheduleInOnStart: Set<string> }
    )._warnedScheduleInOnStart.has(cb);
  }

  @callable()
  async getScheduleCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
    `;
    return result[0].count;
  }
}

/**
 * Agent that calls schedule() in onStart() with idempotent: false — should
 * NOT warn because the user explicitly opted out.
 */
export class TestOnStartScheduleExplicitFalseAgent extends Agent {
  maintenanceCallback() {
    // no-op
  }

  async onStart() {
    await this.schedule(60, "maintenanceCallback", undefined, {
      idempotent: false
    });
  }

  @callable()
  wasWarnedFor(cb: string): boolean {
    return (
      this as unknown as { _warnedScheduleInOnStart: Set<string> }
    )._warnedScheduleInOnStart.has(cb);
  }
}

export class TestScheduleAgent extends Agent {
  // A no-op callback method for testing schedules
  testCallback() {
    // Intentionally empty - used for testing schedule creation
  }

  // Callback that tracks execution count
  intervalCallbackCount = 0;

  intervalCallback() {
    this.intervalCallbackCount++;
  }

  // Callback that throws an error (for testing error resilience)
  throwingCallback() {
    throw new Error("Intentional test error");
  }

  // Track slow callback execution for concurrent execution testing
  slowCallbackExecutionCount = 0;
  slowCallbackStartTimes: number[] = [];
  slowCallbackEndTimes: number[] = [];

  async slowCallback() {
    this.slowCallbackExecutionCount++;
    this.slowCallbackStartTimes.push(Date.now());
    // Simulate a slow operation (500ms)
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.slowCallbackEndTimes.push(Date.now());
  }

  @callable()
  async cancelScheduleById(id: string): Promise<boolean> {
    return this.cancelSchedule(id);
  }

  @callable()
  async getScheduleById(id: string) {
    return this.getSchedule(id);
  }

  @callable()
  async clearStoredAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  @callable()
  async setStoredAlarm(timeMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(timeMs);
  }

  @callable()
  async getStoredAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  @callable()
  async backdateSchedule(id: string, time: number): Promise<void> {
    this.sql`UPDATE cf_agents_schedules SET time = ${time} WHERE id = ${id}`;
  }

  @callable()
  async createSchedule(delaySeconds: number): Promise<string> {
    const schedule = await this.schedule(delaySeconds, "testCallback");
    return schedule.id;
  }

  @callable()
  async createIntervalSchedule(intervalSeconds: number): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );
    return schedule.id;
  }

  @callable()
  async createIntervalScheduleAndReadAlarm(
    intervalSeconds: number
  ): Promise<{ alarm: number | null; id: string }> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );
    const alarm = await this.ctx.storage.getAlarm();
    return { alarm, id: schedule.id };
  }

  @callable()
  async createThrowingIntervalSchedule(
    intervalSeconds: number
  ): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "throwingCallback"
    );
    return schedule.id;
  }

  @callable()
  async getSchedulesByType(
    type: "scheduled" | "delayed" | "cron" | "interval"
  ) {
    return this.getSchedules({ type });
  }

  @callable()
  async createSlowIntervalSchedule(intervalSeconds: number): Promise<string> {
    const schedule = await this.scheduleEvery(intervalSeconds, "slowCallback");
    return schedule.id;
  }

  @callable()
  async simulateHungSchedule(intervalSeconds: number): Promise<string> {
    // Create an interval schedule
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );

    // Manually set running=1 and execution_started_at to 60 seconds ago
    // to simulate a hung callback
    const hungStartTime = Math.floor(Date.now() / 1000) - 60;
    this
      .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = ${hungStartTime} WHERE id = ${schedule.id}`;

    return schedule.id;
  }

  @callable()
  async simulateLegacyHungSchedule(intervalSeconds: number): Promise<string> {
    // Create an interval schedule
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );

    // Manually set running=1 but leave execution_started_at as NULL
    // to simulate a legacy schedule that was running before the migration
    this
      .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = NULL WHERE id = ${schedule.id}`;

    return schedule.id;
  }

  // --- Cron/schedule idempotency test helpers ---

  cronCallback() {
    // Intentionally empty — used for cron schedule testing
  }

  @callable()
  async createCronSchedule(cronExpr: string): Promise<string> {
    const schedule = await this.schedule(cronExpr, "cronCallback");
    return schedule.id;
  }

  @callable()
  async createCronScheduleWithPayload(
    cronExpr: string,
    payload: string
  ): Promise<string> {
    const schedule = await this.schedule(cronExpr, "cronCallback", payload);
    return schedule.id;
  }

  @callable()
  async createCronScheduleNonIdempotent(cronExpr: string): Promise<string> {
    const schedule = await this.schedule(cronExpr, "cronCallback", undefined, {
      idempotent: false
    });
    return schedule.id;
  }

  @callable()
  async createIdempotentDelayedSchedule(delaySeconds: number): Promise<string> {
    const schedule = await this.schedule(
      delaySeconds,
      "testCallback",
      undefined,
      {
        idempotent: true
      }
    );
    return schedule.id;
  }

  @callable()
  async createIdempotentDelayedScheduleWithPayload(
    delaySeconds: number,
    payload: string
  ): Promise<string> {
    const schedule = await this.schedule(
      delaySeconds,
      "testCallback",
      payload,
      {
        idempotent: true
      }
    );
    return schedule.id;
  }

  @callable()
  async createIdempotentScheduledSchedule(dateMs: number): Promise<string> {
    const schedule = await this.schedule(
      new Date(dateMs),
      "testCallback",
      undefined,
      { idempotent: true }
    );
    return schedule.id;
  }

  @callable()
  async getScheduleCount(): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
    `;
    return result[0].count;
  }

  @callable()
  async getScheduleCountByTypeAndCallback(
    type: string,
    cb: string
  ): Promise<number> {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE type = ${type} AND callback = ${cb}
    `;
    return result[0].count;
  }

  @callable()
  async insertStaleDelayedRows(count: number, cb: string): Promise<void> {
    const past = Math.floor(Date.now() / 1000) - 60;
    for (let i = 0; i < count; i++) {
      this.sql`
        INSERT INTO cf_agents_schedules (id, callback, payload, type, delayInSeconds, time)
        VALUES (${`stale-${i}`}, ${cb}, ${null}, 'delayed', 60, ${past})
      `;
    }
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  // --- Idempotency test helpers ---

  // A second callback for testing that idempotency is per-callback
  secondIntervalCallback() {
    // Intentionally empty
  }

  @callable()
  async createIntervalScheduleWithPayload(
    intervalSeconds: number,
    payload: string
  ): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback",
      payload
    );
    return schedule.id;
  }

  @callable()
  async createSecondIntervalSchedule(intervalSeconds: number): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "secondIntervalCallback"
    );
    return schedule.id;
  }
}
