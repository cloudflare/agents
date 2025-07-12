// a shim for cloudflare:email
/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: todo */

export class MockEmailMessage implements EmailMessage {
  from: string;
  to: string;
  message: string;
  constructor(from: string, to: string, message: string) {
    this.from = from;
    this.to = to;
    this.message = message;
  }
  toJSON(): string {
    return JSON.stringify({
      from: this.from,
      message: this.message,
      to: this.to
    });
  }
}

export class MockForwardableEmailMessage
  extends MockEmailMessage
  implements ForwardableEmailMessage
{
  get raw(): ReadableStream<Uint8Array<ArrayBufferLike>> {
    throw new Error("Not implemented");
  }
  get headers(): Headers {
    throw new Error("Not implemented");
  }
  get rawSize(): number {
    throw new Error("Not implemented");
  }
  setReject(reason: string): void {
    throw new Error("Not implemented");
  }
  forward(rcptTo: string, headers?: Headers): Promise<void> {
    throw new Error("Not implemented");
  }
  reply(message: EmailMessage): Promise<void> {
    throw new Error("Not implemented");
  }
}
