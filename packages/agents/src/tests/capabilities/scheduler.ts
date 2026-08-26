import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import { setLifecycleEventSink } from "../../lifecycle/durable-object-lifecycle";
import { Scheduler, type Schedule } from "../../schedules";
import { captureConsoleWarnings } from "../shared/console-capture";

/** One recorded scheduled-callback invocation on a harness object. */
export type SchedulerInvocation = {
  readonly callback: string;
  readonly payload: unknown;
  readonly scheduleId: string;
  readonly hadHostContext: boolean;
};

/**
 * Minimal real host for capability-level Scheduler tests: a Durable Object
 * whose only capability is the Scheduler, with runtime handlers installed so
 * tests can drive real Lifecycle startup, real storage, and real platform
 * alarms. This is the platform-dispatch half of the capability testing
 * pattern (see `capability-harness.ts` for the per-test isolation half).
 */
export class SchedulerHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly invocations: SchedulerInvocation[] = [];
  readonly callbackErrors: string[] = [];
  failuresBeforeSuccess = 0;
  disableAlarmsOnNextCallback = false;

  readonly scheduler = new Scheduler({
    callbacks: {
      remind: async (payload: unknown, schedule: Schedule<unknown>) => {
        if (this.disableAlarmsOnNextCallback) {
          this.disableAlarmsOnNextCallback = false;
          await this.lifecycle.disableAlarms();
        }
        this.#record("remind", payload, schedule);
      },
      flaky: (payload: unknown, schedule: Schedule<unknown>) => {
        if (this.failuresBeforeSuccess > 0) {
          this.failuresBeforeSuccess -= 1;
          throw new Error("flaky failure");
        }
        this.#record("flaky", payload, schedule);
      },
      broken: () => {
        throw new Error("broken callback");
      }
    },
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    hungScheduleTimeoutSeconds: 60,
    onError: (error) => {
      this.callbackErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  #record(
    callback: string,
    payload: unknown,
    schedule: Schedule<unknown>
  ): void {
    this.invocations.push({
      callback,
      payload,
      scheduleId: schedule.id,
      hadHostContext: getCurrentAgent<SchedulerHarnessObject>().agent === this
    });
  }
}

/**
 * Captures the non-idempotent-schedule warning emitted while its own real
 * onStart creates schedules, proving Lifecycle startup state drives it.
 */
export class SchedulerStartupWarnObject extends DurableObject<Cloudflare.Env> {
  readonly #capturedWarnings: string[] = [];

  readonly scheduler = new Scheduler({
    callbacks: {
      maintenance: () => {}
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  async onStart(): Promise<void> {
    await captureConsoleWarnings(this.#capturedWarnings, async () => {
      await this.scheduler.set(60, "maintenance", "a");
      await this.scheduler.set(60, "maintenance", "b");
      await this.scheduler.set(120, "maintenance", "c", {
        idempotent: true
      });
      await this.scheduler.set("0 * * * *", "maintenance");
    });
  }

  async warnings(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return this.#capturedWarnings;
  }

  async scheduleOutsideStartup(): Promise<number> {
    await this.lifecycle.start();
    const before = this.#capturedWarnings.length;
    await captureConsoleWarnings(this.#capturedWarnings, async () => {
      await this.scheduler.set(60, "maintenance", "later");
    });
    return this.#capturedWarnings.length - before;
  }
}

/** Backdate one schedule row so the next alarm phase treats it as due. */
export function backdateScheduleRow(
  storage: DurableObjectStorage,
  id: string
): void {
  storage.sql.exec(
    "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
    Math.floor(Date.now() / 1000) - 5,
    id
  );
}

/** Snapshot returned by {@link ScheduledLifecycleObject.getSchedulerResult}. */
export type ScheduledLifecycleResult = {
  readonly events: readonly string[];
  readonly message: string | null;
  readonly callbackScheduleId: string | null;
  readonly callbackScheduleMessage: string | null;
  readonly alarm: number | null;
  readonly scheduleCount: number;
};

/**
 * A plain Lifecycle Object with the Scheduler installed, used to prove
 * standalone Scheduler behavior through the full Lifecycle: event
 * publication to the diagnostics sink, callback/host context, and recovery
 * across real eviction.
 */
export class ScheduledLifecycleObject extends DurableObject<Cloudflare.Env> {
  readonly #events: string[] = [];
  #message: string | null = null;
  #callbackScheduleId: string | null = null;
  #callbackScheduleMessage: string | null = null;

  readonly scheduler = new Scheduler({
    callbacks: {
      reminder: (
        payload: { message: string },
        schedule: Schedule<{ message: string }>
      ) => {
        this.#events.push(
          getCurrentAgent<ScheduledLifecycleObject>().agent === this
            ? "callback:context"
            : "callback:missing-context"
        );
        this.#message = payload.message;
        this.#callbackScheduleId = schedule.id;
        this.#callbackScheduleMessage = schedule.payload.message;
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  onAlarm(): void {
    this.#events.push(
      getCurrentAgent<ScheduledLifecycleObject>().agent === this
        ? "host:context"
        : "host:missing-context"
    );
  }

  async scheduleReminderWithFailingEventSink(message: string): Promise<string> {
    setLifecycleEventSink(this.lifecycle, () => {
      throw new Error("intentional Lifecycle event sink failure");
    });
    return this.scheduleReminder(message);
  }

  async scheduleReminder(message: string): Promise<string> {
    await this.lifecycle.start();
    const schedule = await this.scheduler.set(86_400, "reminder", {
      message
    });
    const past = Math.floor(Date.now() / 1000) - 1;
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_schedules SET time = ? WHERE id = ?",
      past,
      schedule.id
    );
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return schedule.id;
  }

  async getSchedulerResult(): Promise<ScheduledLifecycleResult> {
    await this.lifecycle.start();
    return {
      events: this.#events,
      message: this.#message,
      callbackScheduleId: this.#callbackScheduleId,
      callbackScheduleMessage: this.#callbackScheduleMessage,
      alarm: await this.ctx.storage.getAlarm(),
      scheduleCount: this.scheduler.getSchedules().length
    };
  }
}
