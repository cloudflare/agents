import { routeAgentEmail, routeAgentRequest } from "agents";

import { Scheduler } from "./agents/scheduler";
import { Stateful } from "./agents/stateful";
import { EmailAgent } from "./agents/email";
import { MockEmailService } from "./agents/mock-email";
import { Chat } from "./agents/chat";
import { Rpc } from "./agents/rpc";
// import { emailHandler } from "./agents/email";

export type Env = {
  Scheduler: DurableObjectNamespace<Scheduler>;
  Stateful: DurableObjectNamespace<Stateful>;
  Email: DurableObjectNamespace<EmailAgent>;
  MockEmailService: DurableObjectNamespace<MockEmailService<Env>>;
  OPENAI_API_KEY: string;
};

export { Scheduler, Stateful, EmailAgent, MockEmailService, Chat, Rpc };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
  // email: emailHandler,
} satisfies ExportedHandler<Env>;
