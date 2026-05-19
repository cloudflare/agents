export {
  AgentChatStateAdapter,
  defaultKeyShard,
  defaultThreadShard
} from "./adapter";
export { ChatStateAgent } from "./agent";
export type { AgentStateAdapterOptions } from "./types";

import { AgentChatStateAdapter } from "./adapter";
import type { AgentStateAdapterOptions } from "./types";

export function createAgentChatState(
  options: AgentStateAdapterOptions
): AgentChatStateAdapter {
  return new AgentChatStateAdapter(options);
}
