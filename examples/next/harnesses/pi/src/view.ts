import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentState,
  InboxState,
  LiveState,
  TranscriptItem,
  TranscriptView
} from "@earendil-works/pi-durable";
import { projectEntry, projectMessage, type PiMessage } from "./transcript";

/** A tool call running now, with its streamed output. */
export type PiRunningTool = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
};

/**
 * Everything a UI shows for one session, projected from pi's conversation
 * view by `projectView` on either side of the wire.
 */
export type PiSessionView = {
  /** The active context as far as the client has it, gaps included. */
  readonly messages: readonly PiMessage[];
  /**
   * Whether the context continues above the oldest message: the UI offers
   * to load the page before it (`ConversationTranscript.loadEarlier`).
   */
  readonly earlier: boolean;
  /** The assistant message being streamed, or null. */
  readonly live: PiMessage | null;
  readonly running: boolean;
  readonly tools: readonly PiRunningTool[];
  /** Submissions queued in pi's inbox behind the running work. */
  readonly queued: number;
  /** Retry backoff pi is waiting out, if any. */
  readonly retry: { readonly at: number; readonly error: string } | null;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
  readonly error: string | null;
};

export const EMPTY_VIEW: PiSessionView = {
  messages: [],
  earlier: false,
  live: null,
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  model: null,
  error: null
};

const LIVE_ID = "live";

/** Why a run ended without an answer, unless the user stopped it. */
function failure(live: LiveState): string | null {
  const failed = live.runFailure;
  if (failed === undefined || failed.reason === "aborted") return null;
  return failed.detail === undefined
    ? `Not answered: ${failed.reason}`
    : `Not answered: ${failed.reason}: ${failed.detail}`;
}

/**
 * The items of the active context. A reset starts a new one, so the view
 * starts at the newest reset's notice the client has, though its transcript
 * may reach further. Nothing before that reset shows, so there is nothing
 * earlier to load either.
 */
function activeItems(
  items: readonly TranscriptItem[]
): readonly TranscriptItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "entry" && item.entry.kind === "pi.reset") {
      return items.slice(i);
    }
  }
  return items;
}

type ProjectedItems = Pick<PiSessionView, "messages" | "earlier">;

/**
 * The messages of a transcript's items. A merge that adds no entries keeps
 * the same items array, so a streamed token does not project them again.
 */
const projected = new WeakMap<readonly TranscriptItem[], ProjectedItems>();

function projectItems(all: readonly TranscriptItem[]): ProjectedItems {
  const cached = projected.get(all);
  if (cached) return cached;
  const items = activeItems(all);
  const messages = items.flatMap((item): PiMessage[] => {
    switch (item.kind) {
      case "earlier":
        return [];
      case "gap":
        return [
          {
            id: `gap-${item.after}-${item.upTo}`,
            role: "gap",
            parts: [],
            timestamp: 0,
            after: item.after,
            upTo: item.upTo
          }
        ];
      case "entry": {
        const message = projectEntry(item.entry);
        return message ? [message] : [];
      }
    }
  });
  const result = { messages, earlier: items[0]?.kind === "earlier" };
  projected.set(all, result);
  return result;
}

/**
 * What a UI shows for a session: pi's conversation view, with the client's
 * whole transcript (`ConversationTranscript.merge()`) in place of the
 * window. Pure, so the browser and the tests run the same code: pi's view
 * is the state, and this is the only place that interprets it. App glue,
 * not part of the harness.
 */
export function projectView(view: TranscriptView): PiSessionView {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const partial = live.generation?.message as AssistantMessage | undefined;
  const { messages, earlier } = projectItems(view.items);
  return {
    messages,
    earlier,
    live: partial ? projectMessage(partial, LIVE_ID) : null,
    running: live.run !== undefined,
    tools: (live.tools ?? [])
      .filter((slot) => slot.status === "running")
      .map((slot) => ({
        callId: slot.callId,
        name: slot.name,
        output: slot.output ?? ""
      })),
    queued: inbox?.items.length ?? 0,
    retry: live.generation?.retry ?? null,
    model: agent?.model ?? null,
    error: failure(live)
  };
}
