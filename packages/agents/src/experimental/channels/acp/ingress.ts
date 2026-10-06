import type { Awaitable, Channel, ParticipantResult } from "../channel";
import { participantRoute } from "../internal";
import type { Participant } from "../protocol";

/** How the gateway takes an ACP channel's WebSocket upgrades. */
export type AcpIngressOptions = {
  /**
   * Who is connecting, from request data you can verify, such as an Access
   * JWT. Return null to refuse the upgrade.
   */
  participant(request: Request): Awaitable<ParticipantResult>;
  /**
   * The agent object the participant reaches, or null to refuse them. That
   * object is the authorization boundary: whoever reaches it may use every
   * conversation in it. Default: an agent object of the participant's own.
   */
  route?(request: Request, participant: Participant): Awaitable<string | null>;
  /**
   * Which upgrades are for the ACP channel. Return false for one that is
   * not. Default: `/acp`.
   */
  match?(request: Request): boolean;
};

/**
 * An ACP channel's side in the gateway: it resolves each WebSocket upgrade
 * and forwards it to the agent, whose `AcpChannel` mounted under the same
 * key serves the connection. ACP clients open and pick sessions
 * themselves, so an upgrade names no conversation.
 *
 * ```ts
 * new ChannelGateway({
 *   agent: (route) => env.CodingAgent.getByName(route),
 *   channels: {
 *     web: web({ participant }),
 *     acp: acp({ participant })
 *   }
 * });
 * ```
 */
export function acp(options: AcpIngressOptions): Channel {
  const match = options.match ?? matchAcpPath;
  const route = options.route;
  return {
    upgrade: {
      match: (request) => (match(request) ? {} : undefined),
      participant: (request) => options.participant(request),
      route: (request, participant) =>
        route ? route(request, participant) : participantRoute(participant)
    }
  };
}

function matchAcpPath(request: Request): boolean {
  return new URL(request.url).pathname === "/acp";
}
