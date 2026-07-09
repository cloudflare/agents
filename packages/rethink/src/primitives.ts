import { DurableObject } from "cloudflare:workers";

export interface InboundEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
}

export interface Primitive {
  fetch?(
    request: Request
  ): Promise<Response | undefined> | Response | undefined;
  webSocketMessage?(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): void | Promise<void>;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  alarm?(): void | Promise<void>;
  onEmail?(msg: InboundEmail): boolean | void | Promise<boolean | void>;
}

export abstract class PrimitiveHost<Env = unknown> extends DurableObject<Env> {
  #primitives?: Primitive[];

  protected abstract build(ctx: DurableObjectState, env: Env): Primitive[];

  private get primitives(): Primitive[] {
    this.#primitives ??= this.build(this.ctx, this.env);
    return this.#primitives;
  }

  async fetch(request: Request): Promise<Response> {
    for (const primitive of this.primitives) {
      const response = await primitive.fetch?.(request);
      if (response) return response;
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    await Promise.all(
      this.primitives.map((primitive) =>
        primitive.webSocketMessage?.(ws, message)
      )
    );
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await Promise.all(
      this.primitives.map((primitive) =>
        primitive.webSocketClose?.(ws, code, reason, wasClean)
      )
    );
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await Promise.all(
      this.primitives.map((primitive) => primitive.webSocketError?.(ws, error))
    );
  }

  async alarm(): Promise<void> {
    await Promise.all(this.primitives.map((primitive) => primitive.alarm?.()));
  }

  async deliverEmail(msg: InboundEmail): Promise<boolean> {
    for (const primitive of this.primitives) {
      const claimed = await primitive.onEmail?.(msg);
      if (claimed === true) return true;
    }
    return false;
  }
}
