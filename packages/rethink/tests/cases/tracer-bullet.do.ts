import {
  ChannelDirectory,
  EmailChannel,
  PrimitiveHost,
  WebSocketChannel,
  type InboundMessage,
  type Primitive
} from "../../src";
import { textDelta } from "../helpers/chunks";
import { mockEmailBinding } from "../helpers/email";

interface TracerEnv {
  SENT_EMAILS: KVNamespace;
}

export class TracerBulletDurableObject extends PrimitiveHost<TracerEnv> {
  protected build(ctx: DurableObjectState, env: TracerEnv): Primitive[] {
    const websocket = new WebSocketChannel(ctx, { path: "/ws" });
    const email = new EmailChannel(ctx, {
      binding: mockEmailBinding(env.SENT_EMAILS),
      from: "agent@example.com"
    });
    const directory = new ChannelDirectory([websocket, email]);

    // Normalize transport-specific inbound messages into one echo handler.
    // The directory supplies the reply route for the message's channel.
    directory.listenAll([websocket, email], (msg: InboundMessage, reply) =>
      reply([textDelta(`${msg.channelId}: ${msg.body}`)])
    );

    return [websocket, email];
  }
}
