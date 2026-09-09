import {
  matchesPath,
  type Channel,
  type ChannelInboundMessageInput,
  type ChannelRoute
} from "agents/channels";

/** The JSON body this Channel accepts. */
export type SupportFormRaw = {
  message: string;
  email: string;
  name?: string;
};

/**
 * A custom Channel: any transport can become a Channel by normalizing its input
 * into `ChannelInboundMessage` events.
 *
 * This example is inbound only, so it never provides a reply surface.
 * Implementing `deliver` is all that would be required for it to become
 * outbound as well. Answering a form submission would involve contacting a
 * linked identity on another Channel.
 */
export function supportForm(options: {
  path: string;
  route?: ChannelRoute<SupportFormRaw>;
}): Channel<SupportFormRaw> {
  return {
    route: options.route,
    ingress: {
      async receive(request) {
        if (!matchesPath(request, options.path)) return null;
        if (request.method !== "POST") {
          // If it's not a POST, maybe we just shouldn't be handling it?
          return {
            events: [],
            response: new Response(null, { status: 405 })
          };
        }

        const raw = (await request.json()) as SupportFormRaw;
        const eventId = crypto.randomUUID();
        const event: ChannelInboundMessageInput = {
          type: "message",
          eventId,
          thread: {
            id: eventId,
            isDirectMessage: true
          },
          actor: {
            id: raw.email,
            ...(raw.name && { fullName: raw.name }),
            identity: { subject: raw.email }
          },
          message: { id: eventId, text: raw.message }
        };

        return {
          events: [{ event, raw }],
          response: Response.json({ accepted: true }, { status: 202 })
        };
      }
    }
  };
}
