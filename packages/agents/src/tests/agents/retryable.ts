import { DurableObject } from "cloudflare:workers";
import { Agent, callable, getCurrentAgent } from "../../index.ts";
import { Lifecycle } from "../../lifecycle";

export class RetryableBaseAgent extends Agent {
  private started = false;

  onStart(): void {
    this.started = true;
  }

  /** Reports whether the RPC ran after startup and inside Agent context. */
  @callable()
  async work(): Promise<string> {
    const inContext = getCurrentAgent().agent === this;
    return this.started && inContext ? "work" : "not ready";
  }
}

/** Opts in to an inherited method when the class is defined. */
export class RetryableChildAgent extends RetryableBaseAgent {
  static {
    Lifecycle.retryable(this, this.prototype.work);
  }
}

/** Opts in from a test, after `RetryableBaseAgent` has wrapped `work`. */
export class LateRetryableChildAgent extends RetryableBaseAgent {}

/** `work` before construction replaces it with a context wrapper. */
export const originalWork = RetryableBaseAgent.prototype.work;

class PlainBaseObject extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);

  work(suffix: string): string {
    return `${this.ctx.id.name}:${suffix}`;
  }
}

export class RetryablePlainObject extends PlainBaseObject {
  static {
    Lifecycle.retryable(this, this.prototype.work);
  }
}

export class NonRetryablePlainObject extends PlainBaseObject {}
