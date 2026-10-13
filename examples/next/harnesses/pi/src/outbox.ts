import type { UserInput } from "@earendil-works/pi-durable";
import type { PiWhenBusy } from "agents/harness/pi";
import type { PiClientMessage, PiServerMessage } from "./protocol";

type Submit = Extract<PiClientMessage, { type: "submit" }>;

/** The part of `localStorage` the outbox uses. */
export type PiOutboxStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

/**
 * Submits the client has sent but not seen answered.
 *
 * A connection can drop after the server admitted a prompt but before the
 * client read its result. Each submit carries an `operationId`, which the
 * harness deduplicates on, so sending it again after a reconnect returns
 * the same operation (`accepted: false`) instead of running the prompt a
 * second time. The client keeps a submit here until a `result` or `error`
 * for it arrives, and sends every one again when the socket opens.
 *
 * With a `storage`, such as `localStorage`, pending submits are saved under
 * `key`, so a reloaded or reopened tab still sends them. Tabs that share the
 * key may each send the same submit; the harness runs it once.
 */
export class PiCommandOutbox {
  readonly #pending = new Map<string, Submit>();
  readonly #storage: PiOutboxStorage | undefined;
  readonly #key: string;

  constructor(storage?: PiOutboxStorage, key = "pi-outbox") {
    this.#storage = storage;
    this.#key = key;
    for (const command of this.#load()) this.#pending.set(command.id!, command);
  }

  /** A new submit, kept until it is acknowledged. */
  submit(input: UserInput, whenBusy?: PiWhenBusy): Submit {
    const id = crypto.randomUUID();
    const command: Submit = {
      type: "submit",
      id,
      operationId: id,
      input,
      ...(whenBusy === undefined ? {} : { whenBusy })
    };
    this.#pending.set(id, command);
    this.#save();
    return command;
  }

  /** Unacknowledged submits, oldest first, to send again on reconnect. */
  pending(): Submit[] {
    return [...this.#pending.values()];
  }

  /** Settle the submit a `result` or `error` answers. */
  receive(message: PiServerMessage): void {
    if (
      (message.type === "result" || message.type === "error") &&
      message.id !== undefined &&
      this.#pending.delete(message.id)
    ) {
      this.#save();
    }
  }

  #load(): Submit[] {
    try {
      const saved = JSON.parse(this.#storage?.getItem(this.#key) ?? "[]");
      return Array.isArray(saved)
        ? saved.filter(
            (command): command is Submit =>
              command?.type === "submit" && typeof command.id === "string"
          )
        : [];
    } catch {
      return [];
    }
  }

  #save(): void {
    try {
      if (this.#pending.size === 0) this.#storage?.removeItem(this.#key);
      else this.#storage?.setItem(this.#key, JSON.stringify(this.pending()));
    } catch {
      // Storage can be full or blocked; the outbox still works in memory.
    }
  }
}
