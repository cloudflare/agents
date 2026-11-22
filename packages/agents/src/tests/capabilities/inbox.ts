import { DurableObject } from "cloudflare:workers";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import { Inbox, type InboxRequest, type InboxRun } from "../../inbox";

/** One handler call a test can see. */
export type InboxCall = {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly merged: readonly string[];
  readonly progress: unknown;
  readonly hadHostContext: boolean;
};

/**
 * Minimal real host for Inbox tests: a Durable Object whose only capability
 * is the Inbox. Handlers park on a gate the test opens, so a test can look
 * at a lane while a request runs.
 */
export class InboxHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly calls: InboxCall[] = [];
  readonly statuses: Array<{ id: string; status: string }> = [];
  /** Requests whose handler has started and not returned. */
  readonly running = new Set<string>();
  /** Every handler call parks on this until {@link release}. */
  #hold: { promise: Promise<void>; open: () => void } | null = null;
  slowStatus = 0;
  /** Milliseconds each `pending` report takes. */
  slowPending = 0;

  readonly inbox = new Inbox({
    handlers: {
      echo: async (payload: { value: string }, run: InboxRun) => {
        this.#record("echo", payload, run);
        await this.#park(run);
        return { echoed: payload.value, attempt: run.attempt };
      },
      fail: async (payload: string, run: InboxRun) => {
        this.#record("fail", payload, run);
        await this.#park(run);
        throw new Error(`failed: ${payload}`);
      },
      settle: async (
        payload: { as: "aborted" | "skipped" | "error" | "detached" },
        run: InboxRun
      ) => {
        this.#record("settle", payload, run);
        await this.#park(run);
        if (payload.as === "aborted") return Inbox.aborted("by handler");
        if (payload.as === "skipped") return Inbox.skipped("by handler");
        if (payload.as === "error") return Inbox.failed("by handler");
        return Inbox.detached();
      },
      progress: async (payload: { note: string }, run: InboxRun) => {
        this.#record("progress", payload, run);
        this.inbox.checkpoint(run.id, { note: payload.note, at: run.attempt });
        await this.#park(run);
        return run.progress ?? null;
      },
      big: async (payload: string, run: InboxRun) => {
        this.#record("big", payload.length, run);
        return payload;
      },
      abortable: (_payload: null, run: InboxRun) => {
        this.#record("abortable", null, run);
        return new Promise((_resolve, reject) => {
          run.signal.addEventListener("abort", () =>
            reject(new Error("aborted in handler"))
          );
        });
      }
    },
    onStatus: async (request: InboxRequest) => {
      this.statuses.push({ id: request.id, status: request.status });
      if (this.slowPending > 0 && request.status === "pending") {
        await new Promise((resolve) => setTimeout(resolve, this.slowPending));
        this.statuses.push({ id: request.id, status: "pending:done" });
      }
      if (
        this.slowStatus > 0 &&
        request.status !== "pending" &&
        request.status !== "running"
      ) {
        await new Promise((resolve) => setTimeout(resolve, this.slowStatus));
      }
    },
    maxAttempts: 2
  });

  /** A second, named inbox that keeps nothing once a request ended. */
  readonly side = new Inbox({
    name: "side",
    retain: false,
    handlers: {
      echo: async (payload: { value: string }, run: InboxRun) => {
        this.#record("side", payload, run);
        await this.#park(run);
        return {
          echoed: payload.value,
          local: run.local ?? null,
          merged: run.merged
        };
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.inbox).use(this.side);

  /** Park every handler that starts until {@link release}. */
  hold(): void {
    if (this.#hold) return;
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#hold = { promise, open };
  }

  release(): void {
    this.#hold?.open();
    this.#hold = null;
  }

  async #park(run: InboxRun): Promise<void> {
    this.running.add(run.id);
    try {
      await this.#hold?.promise;
    } finally {
      this.running.delete(run.id);
    }
  }

  #record(kind: string, payload: unknown, run: InboxRun): void {
    this.calls.push({
      id: run.id,
      kind,
      payload,
      attempt: run.attempt,
      merged: run.merged,
      progress: run.progress,
      hadHostContext: getCurrentAgent<InboxHarnessObject>().agent === this
    });
  }

  /** Write a row as a reset during its terminal onStatus would leave it. */
  forgetReport(id: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_inbox SET notified = NULL WHERE id = ?",
      id
    );
  }

  /** Write a row as an isolate that died mid-run would leave it. */
  interrupt(id: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_inbox SET status = 'running', attempt = attempt + 1 WHERE id = ?",
      id
    );
  }
}

/** Poll until `check` holds or the timeout passes. */
export async function eventually(
  check: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
