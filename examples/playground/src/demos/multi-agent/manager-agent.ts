import { callable, getAgentByName } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";
import type { FanoutWorkerAgent, WorkerResult } from "./fanout-worker-agent";

export interface ManagerState {
  lastRun: {
    items: string[];
    workerCount: number;
    results: WorkerResult[];
    totalDuration: number;
  } | null;
}

export class ManagerAgent extends Agent<Env, ManagerState> {
  initialState: ManagerState = { lastRun: null };

  @callable({ description: "Fan out items to N workers in parallel" })
  async processItems(
    items: string[],
    workerCount: number
  ): Promise<ManagerState["lastRun"]> {
    const start = Date.now();
    const clamped = Math.max(1, Math.min(workerCount, 4));

    const chunkSize = Math.ceil(items.length / clamped);
    const chunks: string[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const results = await Promise.all(
      chunks.map(async (chunk, i) => {
        const worker = await getAgentByName<Env, FanoutWorkerAgent>(
          this.env.FanoutWorkerAgent,
          `worker-${this.name}-${i}`
        );
        return worker.processChunk(`worker-${i}`, chunk);
      })
    );

    const run = {
      items,
      workerCount: chunks.length,
      results,
      totalDuration: Date.now() - start
    };

    this.setState({ lastRun: run });
    return run;
  }
}
