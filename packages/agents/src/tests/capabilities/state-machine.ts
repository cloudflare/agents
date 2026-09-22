import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { LifecycleCapability } from "../../lifecycle/capability";
import type { LifecycleJobContext } from "../../lifecycle/job-queue";
import {
  StateMachine,
  defineMachine,
  settleStreamOnMachineCommit,
  type MachineDefinition,
  type MachineRunSnapshot
} from "../../state-machine";
import { createMachineCommitParticipant } from "../../state-machine/commit";
import { Streams } from "../../streams";

type PipelineState =
  | { phase: "first"; label: string }
  | { phase: "second"; label: string }
  | { phase: "third"; label: string };

type CommitState =
  | { phase: "write"; value: string }
  | { phase: "done"; value: string };

class SyncJobProbe extends LifecycleCapability {
  constructor() {
    super("sync-job-probe");
  }

  async stage(value: string, rollback = false): Promise<void> {
    this.lifecycle.storage.transactionSync(() => {
      this.lifecycle.storage.sql.exec(
        "INSERT INTO sync_job_probe_state (value) VALUES (?)",
        value
      );
      this.lifecycle.jobs.pushSync({
        id: `probe:${value}`,
        fn: "deliver",
        time: Date.now(),
        payload: { value }
      });
      if (rollback) throw new Error("rollback requested");
    });
    await this.lifecycle.jobs.rearm();
  }

  onJob(context: LifecycleJobContext): void {
    const payload = context.job.payload as { value: string };
    this.lifecycle.storage.sql.exec(
      "INSERT INTO sync_job_probe_deliveries (value) VALUES (?)",
      payload.value
    );
  }
}

const pipeline = defineMachine<PipelineState, string, { label: string }>({
  version: 1,
  initial: (input) => ({ phase: "first", label: input.label }),
  phases: {
    first: (state, context) =>
      context.transition({ phase: "second", label: state.label }),
    second: (state, context) =>
      context.transition({ phase: "third", label: state.label }),
    third: (state, context) => context.complete(`done:${state.label}`)
  }
} satisfies MachineDefinition<PipelineState, string, { label: string }>);

export class StateMachineHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams();
  readonly definitions = {
    pipeline,
    participant: defineMachine<CommitState, string, { value: string }>({
      version: 1,
      initial: (input) => ({ phase: "write", value: input.value }),
      phases: {
        write: (state, context) =>
          context.transition(
            { phase: "done", value: state.value },
            {
              commit: [
                createMachineCommitParticipant(() => {
                  this.ctx.storage.sql.exec(
                    "INSERT INTO state_machine_commit_probe (value) VALUES (?)",
                    state.value
                  );
                })
              ]
            }
          ),
        done: (state, context) => context.complete(state.value)
      }
    }),
    streamSettlement: defineMachine<
      { phase: "close"; streamId: string },
      string,
      { streamId: string }
    >({
      version: 1,
      initial: (input) => ({ phase: "close", streamId: input.streamId }),
      phases: {
        close: (state, context) =>
          context.complete(state.streamId, {
            commit: [settleStreamOnMachineCommit(this.streams, state.streamId)]
          })
      }
    }),
    participantFailure: defineMachine<CommitState, string, { value: string }>({
      version: 1,
      initial: (input) => ({ phase: "write", value: input.value }),
      phases: {
        write: (state, context) =>
          context.transition(
            { phase: "done", value: state.value },
            {
              commit: [
                createMachineCommitParticipant(() => {
                  this.ctx.storage.sql.exec(
                    "INSERT INTO state_machine_commit_probe (value) VALUES (?)",
                    state.value
                  );
                  throw new Error("participant failed");
                })
              ]
            }
          ),
        done: (state, context) => context.complete(state.value)
      }
    })
  };

  readonly jobProbe = new SyncJobProbe();
  readonly stateMachine = new StateMachine({ definitions: this.definitions });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.jobProbe)
    .use(this.streams)
    .use(this.stateMachine);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_machine_commit_probe (value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_job_probe_state (value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sync_job_probe_deliveries (value TEXT NOT NULL)"
    );
  }

  start(label: string, runId?: string) {
    return this.stateMachine.run("pipeline", { label }, { runId });
  }

  async stageProbeJob(value: string, rollback = false) {
    try {
      await this.jobProbe.stage(value, rollback);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  probeState(): { state: string[]; deliveries: string[] } {
    const values = (table: string) =>
      this.ctx.storage.sql
        .exec<{ value: string }>(`SELECT value FROM ${table} ORDER BY rowid`)
        .toArray()
        .map((row) => row.value);
    return {
      state: values("sync_job_probe_state"),
      deliveries: values("sync_job_probe_deliveries")
    };
  }

  startParticipant(value: string, fail = false) {
    return fail
      ? this.stateMachine.run("participantFailure", { value })
      : this.stateMachine.run("participant", { value });
  }

  async startStreamSettlement(streamId: string) {
    await this.streams.open(streamId);
    return this.stateMachine.run("streamSettlement", { streamId });
  }

  async streamState(streamId: string): Promise<string | null> {
    return (await this.streams.status(streamId))?.state ?? null;
  }

  snapshot(
    runId: string
  ): Promise<MachineRunSnapshot<PipelineState, string> | null> {
    return this.stateMachine.get(runId, "pipeline");
  }

  runSnapshot(runId: string) {
    return this.stateMachine.get(runId);
  }

  committedValues(): string[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM state_machine_commit_probe ORDER BY rowid"
      )
      .toArray()
      .map((row) => row.value);
  }
}
