import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../lifecycle";
import { ChatLane, type ChatLanePayload } from "../../chat/chat-lane";
import { Inbox } from "../../inbox";

/** An async context a turn should see from the call that queued it. */
export const turnCaller = new AsyncLocalStorage<string>();

/** Minimal real host for the chat lane: a Durable Object with its inbox. */
export class ChatLaneHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly replays: ChatLanePayload[] = [];
  readonly lane = new ChatLane({
    replay: async (payload) => {
      this.replays.push(payload);
      return Inbox.completed("replayed");
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.lane.inbox);

  /** A gate turns can park on. */
  gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }
}
