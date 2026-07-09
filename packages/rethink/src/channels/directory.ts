import type { UIMessageChunk } from "ai";
import type {
  ChannelIn,
  ChannelOut,
  InboundMessage,
  MessageHandler,
  OutStream
} from "./types";

type Reply = (chunks: UIMessageChunk[]) => Promise<void>;

type ListenAllHandler = (
  msg: InboundMessage,
  reply: Reply
) => void | Promise<void>;

/** Registry that connects ChannelIn listeners to ChannelOut reply streams. */
export class ChannelDirectory {
  #outputs = new Map<string, ChannelOut>();

  constructor(outputs: ChannelOut[]) {
    for (const output of outputs) this.#outputs.set(output.channelId, output);
  }

  listen<TRaw, TReplyTo>(
    input: ChannelIn<TRaw, TReplyTo>,
    handler: MessageHandler<TRaw, TReplyTo>
  ): () => void {
    return input.onMessage(handler);
  }

  listenAll(inputs: ChannelIn[], handler: ListenAllHandler): () => void {
    const unsubscribers = inputs.map((input) =>
      input.onMessage((msg) =>
        handler(msg, (chunks) => this.reply(msg, chunks))
      )
    );
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  open(channelId: string, target: unknown): OutStream | undefined {
    return this.#outputs.get(channelId)?.openStream(target);
  }

  async reply<TReplyTo>(
    msg: InboundMessage<unknown, TReplyTo>,
    chunks: UIMessageChunk[]
  ): Promise<void> {
    if (msg.replyTo === undefined) return;
    const stream = this.open(msg.channelId, msg.replyTo);
    if (!stream) return;
    for (const chunk of chunks) await stream.write(chunk);
    await stream.complete();
  }
}
