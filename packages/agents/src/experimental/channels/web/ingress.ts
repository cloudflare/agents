import type {
  Awaitable,
  Channel,
  ChannelUpgradeMatch,
  ParticipantResult
} from "../channel";
import { participantRoute } from "../internal";
import type { Participant } from "../protocol";

/** How the gateway takes the Web Channel's WebSocket upgrades. */
export type WebIngressOptions = {
  /**
   * Who is connecting, from request data you can verify, such as a session
   * cookie or an Access JWT. Return null to refuse the upgrade.
   */
  participant(request: Request): Awaitable<ParticipantResult>;
  /**
   * The agent object the participant reaches, or null to refuse them. That
   * object is the authorization boundary: whoever reaches it may use every
   * conversation in it. Default: an agent object of the participant's own.
   */
  route?(request: Request, participant: Participant): Awaitable<string | null>;
  /**
   * Which upgrades are for the Web Channel, and the conversation each
   * follows. Return undefined for one that is not. Default: `/channels`,
   * or `/channels/<conversation>`.
   */
  match?(request: Request): ChannelUpgradeMatch | undefined;
};

/**
 * The Web Channel's side in the gateway: it resolves each WebSocket upgrade
 * and forwards it to the agent, whose `WebChannel` serves the connection.
 *
 * ```ts
 * new ChannelGateway({
 *   agent: (route) => env.SupportAgent.getByName(route),
 *   channels: {
 *     web: web({
 *       participant: async (request) =>
 *         (await verifySession(request, env))?.id ?? null
 *     })
 *   }
 * });
 * ```
 */
export function web(options: WebIngressOptions): Channel {
  const route = options.route;
  return {
    upgrade: {
      match: options.match ?? matchChannelsPath,
      participant: (request) => options.participant(request),
      route: (request, participant) =>
        route ? route(request, participant) : participantRoute(participant)
    }
  };
}

function matchChannelsPath(request: Request): ChannelUpgradeMatch | undefined {
  const match = /^\/channels(?:\/([^/]+))?$/.exec(
    new URL(request.url).pathname
  );
  if (!match) return undefined;
  return match[1] === undefined
    ? {}
    : { conversationId: decodeURIComponent(match[1]) };
}
