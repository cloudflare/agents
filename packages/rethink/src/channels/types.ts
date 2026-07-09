import type { UIMessageChunk } from "ai";

/** A transport-neutral inbound envelope emitted by ChannelIn primitives. */
export interface InboundMessage<TRaw = unknown, TReplyTo = unknown> {
  channelId: string;
  from: string;
  body: string;
  replyTo?: TReplyTo;
  raw?: TRaw;
}

/** Progressive outbound writer returned by ChannelOut primitives. */
export interface OutStream {
  write(chunk: UIMessageChunk): void | Promise<void>;
  complete(): void | Promise<void>;
  interrupt(): void | Promise<void>;
  error(err: unknown): void | Promise<void>;
}

/** Listener registered by consumers that want inbound channel messages. */
export type MessageHandler<TRaw = unknown, TReplyTo = unknown> = (
  msg: InboundMessage<TRaw, TReplyTo>
) => void | Promise<void>;

/** Ingress role for primitives that emit transport-normalized messages. */
export interface ChannelIn<TRaw = unknown, TReplyTo = unknown> {
  readonly channelId: string;
  onMessage(handler: MessageHandler<TRaw, TReplyTo>): () => void;
}

/** Egress role for primitives that deliver chunks to explicit targets. */
export interface ChannelOut<TTarget = unknown> {
  readonly channelId: string;
  openStream(target: TTarget): OutStream;
}

export type { UIMessageChunk } from "ai";
