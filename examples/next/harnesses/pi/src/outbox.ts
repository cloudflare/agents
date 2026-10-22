import type { UserInput } from "@earendil-works/pi-durable";
import type { PiWhenBusy } from "agents/harness/pi";
import type { PiClientMessage, PiServerMessage } from "./protocol";

/** A submit as the outbox sends it: always named, by id and operation id. */
export type PiOutboxSubmit = Extract<PiClientMessage, { type: "submit" }> & {
  readonly id: string;
  readonly operationId: string;
};

/**
 * Submits the client has sent but not seen answered, in memory.
 *
 * A connection can drop after the server admitted a prompt but before the
 * client read its result. Each submit carries an `operationId` equal to its
 * message id, which the harness deduplicates on, so sending it again returns
 * the same operation (`accepted: false`) instead of running the prompt
 * twice. The client keeps a submit here until a `result` or `error` with its
 * id arrives, and sends every pending one again when the socket opens.
 */
export class PiCommandOutbox {
  readonly #pending = new Map<string, PiOutboxSubmit>();

  /** A new submit, kept until it is answered. */
  submit(input: UserInput, whenBusy?: PiWhenBusy): PiOutboxSubmit {
    const id = crypto.randomUUID();
    const command: PiOutboxSubmit = {
      type: "submit",
      id,
      operationId: id,
      input,
      ...(whenBusy === undefined ? {} : { whenBusy })
    };
    this.#pending.set(id, command);
    return command;
  }

  /** Unanswered submits, oldest first. */
  pending(): PiOutboxSubmit[] {
    return [...this.#pending.values()];
  }

  /** Send every unanswered submit again, as the socket opens. */
  sendPending(send: (data: string) => void): void {
    for (const command of this.#pending.values()) send(JSON.stringify(command));
  }

  /** Forget every unanswered submit. */
  clear(): void {
    this.#pending.clear();
  }

  /** Drop the submit a `result` or `error` answers. */
  receive(message: PiServerMessage): void {
    if (message.type !== "result" && message.type !== "error") return;
    if (message.id !== undefined) this.#pending.delete(message.id);
  }
}
