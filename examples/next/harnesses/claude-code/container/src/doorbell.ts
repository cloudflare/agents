/**
 * The doorbell: a POST to the Worker that wakes the Durable Object when
 * frames pile up with nobody subscribed.
 *
 * It carries no payload the other side needs. Everything in the body is
 * re-derived on reconcile, so a lost, duplicated or out-of-order ring costs
 * nothing; the only thing that matters is that at least one gets through.
 * Rings are coalesced to at most one in flight and at most one per second,
 * because a busy turn would otherwise ring on every frame.
 */
import {
  HARNESS_SECRET_HEADER,
  type HarnessDoorbellBody
} from "../../../shared/src/protocol.ts";

const MIN_INTERVAL_MS = 1_000;

export class Doorbell {
  readonly #url: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #secret: string;
  readonly #sessionId: string;
  readonly #log: (...args: readonly unknown[]) => void;
  #inFlight = false;
  #pending: HarnessDoorbellBody | undefined;
  #lastAt = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly url: string | undefined;
    /** Sent with every ring, before the secret header. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly secret: string;
    readonly sessionId: string;
    readonly log: (...args: readonly unknown[]) => void;
  }) {
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#secret = options.secret;
    this.#sessionId = options.sessionId;
    this.#log = options.log;
  }

  /** Ask for a ring. Safe to call on every frame. */
  ring(runtimeId: string, highWaterSeq: number, reason: string): void {
    if (this.#url === undefined || this.#url === "") return;
    this.#pending = {
      sessionId: this.#sessionId,
      runtimeId,
      highWaterSeq,
      reason
    };
    this.#schedule();
  }

  /** Stop ringing. Called on shutdown so the process can exit. */
  close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
  }

  #schedule(): void {
    if (
      this.#inFlight ||
      this.#timer !== undefined ||
      this.#pending === undefined
    ) {
      return;
    }
    const wait = Math.max(0, this.#lastAt + MIN_INTERVAL_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#send();
    }, wait);
    // A pending ring must never hold the process open on its own.
    this.#timer.unref?.();
  }

  async #send(): Promise<void> {
    const body = this.#pending;
    if (body === undefined || this.#url === undefined) return;
    this.#pending = undefined;
    this.#inFlight = true;
    this.#lastAt = Date.now();
    try {
      await fetch(this.#url, {
        method: "POST",
        headers: {
          ...this.#headers,
          "content-type": "application/json",
          [HARNESS_SECRET_HEADER]: this.#secret
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      // Best effort by design: the next ring, or the renewal job, retries.
      this.#log("doorbell failed", error);
    } finally {
      this.#inFlight = false;
      this.#schedule();
    }
  }
}
