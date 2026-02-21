import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface WorkerResult {
  workerId: string;
  items: string[];
  processed: string[];
  duration: number;
}

export class FanoutWorkerAgent extends Agent<Env> {
  async processChunk(workerId: string, items: string[]): Promise<WorkerResult> {
    const start = Date.now();

    const processed = items.map((item) => {
      const trimmed = item.trim();
      const upper = trimmed.toUpperCase();
      const reversed = trimmed.split("").reverse().join("");
      return `${upper} (${trimmed.length} chars, reversed: ${reversed})`;
    });

    await new Promise((resolve) =>
      setTimeout(resolve, 200 + Math.random() * 300)
    );

    return {
      workerId,
      items,
      processed,
      duration: Date.now() - start
    };
  }
}
