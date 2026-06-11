/**
 * Task queue capability (Layer 1). Owns the `cf_agents_queues` table.
 *
 * The `Agent` class delegates its public `queue()`/`dequeue*()`/
 * `getQueue*()` methods here; the capability talks to the agent only
 * through the narrow {@link QueueHost} slice.
 */

import { nanoid } from "nanoid";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import {
  parseRetryOptions,
  resolveRetryConfig,
  tryN,
  validateRetryOptions
} from "../retries";
import type { RetryOptions } from "../retries";
import type { SqlHost } from "../core/host";
import type { QueueItem } from "../index";

type QueueEventType = "queue:create" | "queue:retry" | "queue:error";

/** The slice of the agent the queue capability needs. */
export interface QueueHost {
  /** The agent instance — ALS context value and callback dispatch target. */
  agent: object;
  sql: SqlHost["sql"];
  emit(type: QueueEventType, payload: Record<string, unknown>): void;
  retryDefaults(): Required<RetryOptions>;
  onError(e: unknown): void | Promise<void>;
}

export class AgentQueue {
  private readonly _host: QueueHost;
  private _flushing = false;

  constructor(host: QueueHost) {
    this._host = host;
  }

  /**
   * Queue a task to be executed in the future.
   * @returns The ID of the queued task
   */
  async enqueue<T = unknown>(
    callback: string,
    payload: T,
    options?: { retry?: RetryOptions }
  ): Promise<string> {
    const id = nanoid(9);
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (
      typeof (this._host.agent as Record<string, unknown>)[callback] !==
      "function"
    ) {
      throw new Error(`this.${callback} is not a function`);
    }

    if (options?.retry) {
      validateRetryOptions(options.retry, this._host.retryDefaults());
    }

    const retryJson = options?.retry ? JSON.stringify(options.retry) : null;

    this._host.sql`
      INSERT OR REPLACE INTO cf_agents_queues (id, payload, callback, retry_options)
      VALUES (${id}, ${JSON.stringify(payload)}, ${callback}, ${retryJson})
    `;

    this._host.emit("queue:create", { callback, id });

    void this.flush().catch((e) => {
      console.error("Error flushing queue:", e);
    });

    return id;
  }

  /** Drain the queue, invoking each row's callback on the agent. */
  async flush(): Promise<void> {
    if (this._flushing) {
      return;
    }
    this._flushing = true;
    try {
      while (true) {
        const result = this._host.sql<QueueItem<string>>`
        SELECT * FROM cf_agents_queues
        ORDER BY created_at ASC
      `;

        if (!result || result.length === 0) {
          break;
        }

        for (const row of result || []) {
          const agent = this._host.agent as Record<string, unknown>;
          const callback = agent[row.callback as string];
          if (!callback) {
            console.error(`callback ${String(row.callback)} not found`);
            this.dequeue(row.id);
            continue;
          }
          const { connection, request, email } = agentContext.getStore() || {};
          await agentContext.run(
            {
              agent: this._host.agent,
              connection,
              request,
              email
            },
            async () => {
              const retryOpts = parseRetryOptions(
                row as unknown as Record<string, unknown>
              );
              const { maxAttempts, baseDelayMs, maxDelayMs } =
                resolveRetryConfig(retryOpts, this._host.retryDefaults());
              const parsedPayload = JSON.parse(row.payload as string);
              try {
                await tryN(
                  maxAttempts,
                  async (attempt) => {
                    if (attempt > 1) {
                      this._host.emit("queue:retry", {
                        callback: row.callback,
                        id: row.id,
                        attempt,
                        maxAttempts
                      });
                    }
                    await (
                      callback as (
                        payload: unknown,
                        queueItem: QueueItem<string>
                      ) => Promise<void>
                    ).call(this._host.agent, parsedPayload, row);
                  },
                  { baseDelayMs, maxDelayMs }
                );
              } catch (e) {
                console.error(
                  `queue callback "${String(row.callback)}" failed after ${maxAttempts} attempts`,
                  e
                );
                this._host.emit("queue:error", {
                  callback: row.callback,
                  id: row.id,
                  error: e instanceof Error ? e.message : String(e),
                  attempts: maxAttempts
                });
                try {
                  await this._host.onError(e);
                } catch {
                  // swallow onError errors
                }
              } finally {
                this.dequeue(row.id);
              }
            }
          );
        }
      }
    } finally {
      this._flushing = false;
    }
  }

  /** Dequeue a task by ID. */
  dequeue(id: string): void {
    this._host.sql`DELETE FROM cf_agents_queues WHERE id = ${id}`;
  }

  /** Dequeue all tasks. */
  dequeueAll(): void {
    this._host.sql`DELETE FROM cf_agents_queues`;
  }

  /** Dequeue all tasks for a callback. */
  dequeueAllByCallback(callback: string): void {
    this._host.sql`DELETE FROM cf_agents_queues WHERE callback = ${callback}`;
  }

  /** Get a queued task by ID, or undefined if not found. */
  get(id: string): QueueItem<string> | undefined {
    const result = this._host.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues WHERE id = ${id}
    `;
    if (!result || result.length === 0) return undefined;
    const row = result[0];
    return {
      ...row,
      payload: JSON.parse(row.payload as unknown as string),
      retry: parseRetryOptions(row as unknown as Record<string, unknown>)
    };
  }

  /** Get all queued tasks whose payload has `payload[key] === value`. */
  getAll(key: string, value: string): QueueItem<string>[] {
    const result = this._host.sql<QueueItem<string>>`
      SELECT * FROM cf_agents_queues
    `;
    return result
      .filter(
        (row) => JSON.parse(row.payload as unknown as string)[key] === value
      )
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload as unknown as string),
        retry: parseRetryOptions(row as unknown as Record<string, unknown>)
      }));
  }
}
