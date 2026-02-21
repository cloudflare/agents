import { callable } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface RetryAgentState {
  log: Array<{
    id: string;
    type: "attempt" | "success" | "failure" | "info";
    message: string;
    timestamp: number;
  }>;
}

/**
 * Demo agent showcasing retry capabilities:
 * - this.retry() for ad-hoc retries
 * - shouldRetry for selective retry
 * - queue() with retry options
 * - Class-level retry defaults via static options
 */
export class RetryAgent extends Agent<Env, RetryAgentState> {
  // Class-level retry defaults — applies to this.retry(), queue(), and schedule()
  static options = {
    retry: { maxAttempts: 4, baseDelayMs: 50, maxDelayMs: 1000 }
  };

  initialState: RetryAgentState = {
    log: []
  };

  private appendLog(
    type: RetryAgentState["log"][number]["type"],
    message: string
  ) {
    const entry = {
      id: crypto.randomUUID(),
      type,
      message,
      timestamp: Date.now()
    };
    this.setState({
      ...this.state,
      log: [...this.state.log, entry]
    });
    this.broadcast(JSON.stringify({ type: "log", entry }));
  }

  @callable({
    description: "Retry a flaky operation (succeeds on Nth attempt)"
  })
  async retryFlaky(succeedOnAttempt: number): Promise<string> {
    this.appendLog(
      "info",
      `Starting flaky operation (succeeds on attempt ${succeedOnAttempt})`
    );

    const result = await this.retry(async (attempt) => {
      this.appendLog("attempt", `Attempt ${attempt}...`);
      if (attempt < succeedOnAttempt) {
        throw new Error(`Transient failure on attempt ${attempt}`);
      }
      return `Success on attempt ${attempt}`;
    });

    this.appendLog("success", result);
    return result;
  }

  @callable({
    description: "Retry with shouldRetry — bails on 'permanent' errors"
  })
  async retryWithFilter(
    failCount: number,
    permanent: boolean
  ): Promise<string> {
    const errorType = permanent ? "permanent" : "transient";
    this.appendLog(
      "info",
      `Starting filtered retry (${failCount} ${errorType} failures then success)`
    );

    try {
      const result = await this.retry(
        async (a) => {
          this.appendLog("attempt", `Attempt ${a}...`);
          if (a <= failCount) {
            const err = new Error(`${errorType} failure on attempt ${a}`);
            (err as unknown as { permanent: boolean }).permanent = permanent;
            throw err;
          }
          return `Success on attempt ${a}`;
        },
        {
          maxAttempts: 10,
          shouldRetry: (err) => {
            const isPermanent = (err as { permanent?: boolean }).permanent;
            if (isPermanent) {
              this.appendLog(
                "info",
                "shouldRetry returned false — bailing out"
              );
              return false;
            }
            return true;
          }
        }
      );

      this.appendLog("success", result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendLog("failure", `Gave up: ${msg}`);
      throw e;
    }
  }

  @callable({ description: "Queue a task with retry options" })
  async queueWithRetry(maxAttempts: number): Promise<string> {
    this.appendLog("info", `Queuing task with ${maxAttempts} max attempts`);
    const id = await this.queue(
      "onQueuedTask",
      { maxAttempts },
      {
        retry: { maxAttempts, baseDelayMs: 50, maxDelayMs: 500 }
      }
    );
    return id;
  }

  private _queueAttempts = 0;

  async onQueuedTask(payload: { maxAttempts: number }) {
    this._queueAttempts++;
    this.appendLog("attempt", `Queue callback attempt ${this._queueAttempts}`);

    // Fail the first few times, succeed on the last attempt
    if (this._queueAttempts < payload.maxAttempts) {
      throw new Error(`Queue task failed (attempt ${this._queueAttempts})`);
    }

    this.appendLog(
      "success",
      `Queue task succeeded on attempt ${this._queueAttempts}`
    );
    this._queueAttempts = 0;
  }

  @callable({ description: "Clear the log" })
  clearLog() {
    this._queueAttempts = 0;
    this.setState({ ...this.state, log: [] });
  }
}
