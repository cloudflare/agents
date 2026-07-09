import type { EmailSendBinding } from "agents";
import type { UIMessageChunk } from "ai";
import type { InboundEmail, Primitive } from "../primitives";
import type {
  ChannelIn,
  ChannelOut,
  InboundMessage,
  MessageHandler,
  OutStream
} from "./types";
import { textFromChunk } from "./utils";

/** Raw email details preserved on inbound messages for email-specific consumers. */
export interface EmailRaw {
  from: string;
  to: string;
  subject: string;
  messageId?: string;
}

/** Serializable target for replying over email. */
export interface EmailTarget {
  to: string;
  subject?: string;
  inReplyTo?: string;
}

export interface EmailChannelDeps {
  binding: EmailSendBinding;
  from: string;
}

/** Channel primitive that turns forwarded email into messages and replies. */
export class EmailChannel
  implements
    Primitive,
    ChannelIn<EmailRaw, EmailTarget>,
    ChannelOut<EmailTarget>
{
  readonly channelId: string;
  #handler?: MessageHandler<EmailRaw, EmailTarget>;

  constructor(
    private _ctx: DurableObjectState,
    private deps: EmailChannelDeps,
    options: { channelId?: string } = {}
  ) {
    this.channelId = options.channelId ?? "email";
  }

  onMessage(handler: MessageHandler<EmailRaw, EmailTarget>): () => void {
    this.#handler = handler;
    return () => {
      if (this.#handler === handler) this.#handler = undefined;
    };
  }

  async onEmail(msg: InboundEmail): Promise<boolean> {
    await this.emit({
      channelId: this.channelId,
      from: msg.from,
      body: msg.body,
      replyTo: {
        to: msg.from,
        subject: `re: ${msg.subject}`,
        inReplyTo: msg.messageId
      },
      raw: {
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        messageId: msg.messageId
      }
    });
    return true;
  }

  openStream(target: EmailTarget): OutStream {
    const chunks: UIMessageChunk[] = [];
    const deps = this.deps;
    return {
      write(chunk) {
        chunks.push(chunk);
      },
      async complete() {
        await deps.binding.send({
          from: deps.from,
          to: target.to,
          subject: target.subject ?? "message",
          text: chunks.map(textFromChunk).join(""),
          headers: target.inReplyTo
            ? { "In-Reply-To": target.inReplyTo }
            : undefined
        });
      },
      interrupt() {
        return;
      },
      error() {
        return;
      }
    };
  }

  private async emit(
    msg: InboundMessage<EmailRaw, EmailTarget>
  ): Promise<void> {
    await this.#handler?.(msg);
  }
}
