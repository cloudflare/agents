export {
  ChatSdkStateAdapter,
  defaultKeyShard,
  defaultThreadShard
} from "./adapter";
export { ChatSdkStateAgent } from "./agent";
export type { ChatSdkStateParent, ChatSdkStateAdapterOptions } from "./types";

import { ChatSdkStateAdapter } from "./adapter";
import type { ChatSdkStateAdapterOptions } from "./types";

export function createChatSdkState(
  options: ChatSdkStateAdapterOptions = {}
): ChatSdkStateAdapter {
  return new ChatSdkStateAdapter(options);
}
