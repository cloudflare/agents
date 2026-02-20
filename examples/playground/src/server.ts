import { routeAgentRequest, routeAgentEmail, getAgentByName } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver
} from "agents/email";

// Core agents
export { StateAgent } from "./demos/core/state-agent";
export { CallableAgent } from "./demos/core/callable-agent";
export { StreamingAgent } from "./demos/core/streaming-agent";
export { ScheduleAgent } from "./demos/core/schedule-agent";
export { SqlAgent } from "./demos/core/sql-agent";
export { ConnectionsAgent } from "./demos/core/connections-agent";
export { RoutingAgent } from "./demos/core/routing-agent";
export { ReadonlyAgent } from "./demos/core/readonly-agent";
export { RetryAgent } from "./demos/core/retry-agent";

// AI agents
export { ChatAgent } from "./demos/ai/chat-agent";
export { ToolsAgent } from "./demos/ai/tools-agent";
export { CodemodeAgent } from "./demos/ai/codemode-agent";

// Multi-agent demos
export { SupervisorAgent } from "./demos/multi-agent/supervisor-agent";
export { ChildAgent } from "./demos/multi-agent/child-agent";
export { LobbyAgent } from "./demos/multi-agent/lobby-agent";
export { RoomAgent } from "./demos/multi-agent/room-agent";

// Workflow demos
export { BasicWorkflowAgent } from "./demos/workflow/basic-workflow-agent";
export { ApprovalAgent } from "./demos/workflow/approval-agent";
export { ProcessingWorkflow } from "./demos/workflow/processing-workflow";
export { ApprovalWorkflow } from "./demos/workflow/approval-workflow";

// Email agents
export { ReceiveEmailAgent } from "./demos/email/receive-email-agent";
export { SecureEmailAgent } from "./demos/email/secure-email-agent";

export default {
  /**
   * Email handler for Cloudflare Email Routing
   *
   * Routes emails to the appropriate agent based on:
   * 1. Secure reply headers (for replies to signed outbound emails)
   * 2. Address-based routing (e.g., receive+instanceId@domain)
   */
  async email(message: ForwardableEmailMessage, env: Env) {
    console.log("📮 Email received:", message.from, "->", message.to);

    // Create resolvers
    const secureResolver = createSecureReplyEmailResolver(
      env.EMAIL_SECRET || "demo-secret-not-configured"
    );

    // Address-based routing:
    // - "receive+id@domain" routes to ReceiveEmailAgent with agentId "id"
    // - "secure+id@domain" routes to SecureEmailAgent with agentId "id"
    // - Plain addresses default to ReceiveEmailAgent
    const addressResolver =
      createAddressBasedEmailResolver("ReceiveEmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email, env) => {
        // First check if this is a secure reply (has valid signed headers)
        const secureReply = await secureResolver(email, env);
        if (secureReply) {
          console.log(
            "🔐 Routing as secure reply to:",
            secureReply.agentName,
            secureReply.agentId
          );
          return secureReply;
        }

        // Otherwise route based on address
        const addressRoute = await addressResolver(email, env);
        if (addressRoute) {
          console.log(
            "📧 Routing by address to:",
            addressRoute.agentName,
            addressRoute.agentId
          );
        }
        return addressRoute;
      },
      onNoRoute: async (email) => {
        console.warn(
          "⚠️ No route found for email:",
          email.from,
          "->",
          email.to
        );
      }
    });
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Custom basePath routing example:
    // Routes /custom-routing/{instanceName} to a RoutingAgent instance.
    // The server controls which agent instance handles the request,
    // and the client connects using `basePath` instead of `agent` + `name`.
    if (url.pathname.startsWith("/custom-routing/")) {
      const instanceName = url.pathname.replace("/custom-routing/", "");
      if (instanceName) {
        const agent = await getAgentByName(env.RoutingAgent, instanceName);
        return agent.fetch(request);
      }
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
