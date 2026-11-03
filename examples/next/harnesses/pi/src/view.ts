import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentState,
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState
} from "@earendil-works/pi-durable";
import { projectEntries, projectMessage, type PiMessage } from "./transcript";

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
  readonly messages: readonly PiMessage[];
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
 * The entries of the active context. A reset starts a new one, so the view
 * starts at the newest reset's notice, though pi's window may reach further.
 */
function activeEntries(
  entries: readonly EntryRecord[]
): readonly EntryRecord[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "pi.reset") return entries.slice(i);
  }
  return entries;
}

/**
 * What a UI shows for pi's conversation view. Pure, so the browser and the
 * tests run the same code: pi's view is the state, and this is the only
 * place that interprets it. App glue, not part of the harness.
 */
export function projectView(view: ConversationView): PiSessionView {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const partial = live.generation?.message as AssistantMessage | undefined;
  return {
    messages: projectEntries(activeEntries(view.entries)),
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
