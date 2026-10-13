import type { UserInput } from "@earendil-works/pi-durable";
import type { PiWhenBusy } from "agents/harness/pi";
import type { PiClientMessage, PiServerMessage } from "./protocol";

type Submit = Extract<PiClientMessage, { type: "submit" }>;

/**
 * Submits the client has sent but not seen answered.
 *
 * A connection can drop after the server admitted a prompt but before the
 * client read its result. Each submit carries an `operationId`, which the
 * harness deduplicates on, so sending it again after a reconnect returns
 * the same operation (`accepted: false`) instead of running the prompt a
 * second time. The client keeps a submit here until a `result` or `error`
 * for it arrives, and sends every one again when the socket reopens.
 *
 * The outbox lives in memory, so a closed tab loses it.
 */
export class PiCommandOutbox {
  readonly #pending = new Map<string, Submit>();

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
      message.id !== undefined
    ) {
      this.#pending.delete(message.id);
    }
  }
}
