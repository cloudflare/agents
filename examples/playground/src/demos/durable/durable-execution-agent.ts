import { callable, type FiberContext, type FiberRecoveryContext } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

type ResearchJobStatus = "running" | "completed" | "failed" | "recovered";

export interface ResearchJob {
  id: string;
  topic: string;
  status: ResearchJobStatus;
  currentStep: number;
  totalSteps: number;
  checkpoint: string;
  notes: string[];
  startedAt: number;
  completedAt?: number;
  recoveredAt?: number;
}

export interface DurableExecutionState {
  jobs: ResearchJob[];
  recoveries: Array<{
    id: string;
    jobId: string | null;
    name: string;
    snapshot: unknown;
    recoveredAt: number;
  }>;
}

const RESEARCH_STEPS = [
  "Create outline",
  "Gather sources",
  "Compare findings",
  "Draft summary",
  "Polish final answer"
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJobId(name: string) {
  const prefix = "research-report:";
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

export class DurableExecutionAgent extends Agent<Env, DurableExecutionState> {
  initialState: DurableExecutionState = {
    jobs: [],
    recoveries: []
  };

  private updateJob(id: string, patch: Partial<ResearchJob>) {
    this.setState({
      ...this.state,
      jobs: this.state.jobs.map((job) =>
        job.id === id ? { ...job, ...patch } : job
      )
    });
  }

  private broadcastEvent(type: string, payload: unknown) {
    this.broadcast(JSON.stringify({ type, payload }));
  }

  @callable({
    description: "Start a long-running report job in a durable fiber"
  })
  async startResearchReport(topic: string): Promise<string> {
    const id = crypto.randomUUID();
    const job: ResearchJob = {
      id,
      topic,
      status: "running",
      currentStep: 0,
      totalSteps: RESEARCH_STEPS.length,
      checkpoint: "Queued",
      notes: [],
      startedAt: Date.now()
    };

    this.setState({
      ...this.state,
      jobs: [job, ...this.state.jobs].slice(0, 8)
    });
    this.broadcastEvent("job_started", job);

    void this.runFiber(`research-report:${id}`, (ctx) =>
      this.runResearchReport(ctx, id, topic)
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.updateJob(id, {
        status: "failed",
        checkpoint: message,
        completedAt: Date.now()
      });
      this.broadcastEvent("job_failed", { id, message });
    });

    return id;
  }

  private async runResearchReport(
    ctx: FiberContext,
    id: string,
    topic: string
  ) {
    for (const [index, step] of RESEARCH_STEPS.entries()) {
      const checkpoint = `${step} for "${topic}"`;
      const note = `${step} completed`;

      ctx.stash({
        jobId: id,
        topic,
        step,
        stepIndex: index + 1,
        updatedAt: Date.now()
      });

      this.updateJob(id, {
        currentStep: index + 1,
        checkpoint,
        notes: [
          ...(this.state.jobs.find((job) => job.id === id)?.notes ?? []),
          note
        ]
      });
      this.broadcastEvent("job_checkpoint", { id, step, index: index + 1 });

      await wait(700);
    }

    this.updateJob(id, {
      status: "completed",
      checkpoint: "Final report is ready",
      completedAt: Date.now()
    });
    this.broadcastEvent("job_completed", { id });
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    const jobId = parseJobId(ctx.name);
    const recovery = {
      id: ctx.id,
      jobId,
      name: ctx.name,
      snapshot: ctx.snapshot,
      recoveredAt: Date.now()
    };

    this.setState({
      ...this.state,
      recoveries: [recovery, ...this.state.recoveries].slice(0, 5),
      jobs: this.state.jobs.map((job) =>
        job.id === jobId
          ? {
              ...job,
              status: "recovered",
              checkpoint: "Recovered from checkpoint; ready to resume manually",
              recoveredAt: recovery.recoveredAt
            }
          : job
      )
    });
    this.broadcastEvent("fiber_recovered", recovery);
  }

  @callable({ description: "Clear all demo jobs and recovery records" })
  clearJobs() {
    this.setState({ jobs: [], recoveries: [] });
  }
}
