import type { AgentClient } from "../client";
import type { AgentConnection } from "../chat/transport";

declare const client: AgentClient;
client satisfies AgentConnection;
