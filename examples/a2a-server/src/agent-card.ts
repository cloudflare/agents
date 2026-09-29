import { A2A_PROTOCOL_VERSION, AgentCard } from "@a2a-js/sdk";

interface AgentCardOptions {
  description: string;
  name: string;
  route: "coordinator" | "specialist";
  skillId: string;
}

/** Describes one public A2A endpoint exposed by this Worker. */
export function buildAgentCard(
  origin: string,
  options: AgentCardOptions
): AgentCard {
  return AgentCard.fromJSON({
    name: options.name,
    description: options.description,
    supportedInterfaces: [
      {
        url: `${origin}/${options.route}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION
      }
    ],
    provider: {
      organization: "Cloudflare Agents examples",
      url: "https://github.com/cloudflare/agents"
    },
    version: "1.0.0",
    capabilities: {
      extensions: []
    },
    securitySchemes: {
      bearerAuth: {
        httpAuthSecurityScheme: {
          description: "Opaque bearer token for this demonstration server.",
          scheme: "Bearer",
          bearerFormat: "opaque"
        }
      }
    },
    securityRequirements: [
      {
        schemes: {
          bearerAuth: { list: [] }
        }
      }
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: options.skillId,
        name: options.name,
        description: options.description,
        tags: ["a2a", "agents", options.route],
        examples: ["Draft and challenge a concise implementation proposal."],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"]
      }
    ],
    signatures: []
  });
}
