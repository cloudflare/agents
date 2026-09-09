import type { Entry } from "@earendil-works/pi-agent-core";
import type {
  ReadonlySessionManager,
  SessionEntry,
  SessionHeader,
  SessionTreeNode
} from "../../../vendor/pi-coding-agent-src/core/session-manager.ts";
import type { ExtensionLaneStates } from "./state";

/** Upstream keeps session entries as ISO strings; the harness keeps epochs. */
function isoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Project one durable harness entry into the session entry shape extensions
 * read. The two differ in bookkeeping only: the harness numbers entries and
 * keeps compaction tails, upstream keeps file offsets and ISO timestamps.
 */
export function projectSessionEntry(entry: Entry): SessionEntry {
  const base = {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: isoTimestamp(entry.timestamp)
  };
  switch (entry.type) {
    case "message":
      return { ...base, type: "message", message: entry.message };
    case "compaction":
      return {
        ...base,
        type: "compaction",
        summary: entry.summary,
        // The harness retains a message tail rather than an entry cursor.
        firstKeptEntryId: entry.id,
        tokensBefore: entry.tokensBefore,
        ...(entry.details === undefined ? {} : { details: entry.details }),
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        fromHook: entry.fromHook
      };
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: entry.fromId ?? entry.id,
        summary: entry.summary,
        ...(entry.details === undefined ? {} : { details: entry.details }),
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        fromHook: entry.fromHook
      };
    case "custom":
      return {
        ...base,
        type: "custom",
        customType: entry.customType,
        ...(entry.data === undefined ? {} : { data: entry.data })
      };
  }
}

/** Options identifying the session the view describes. */
export type SessionViewOptions = {
  readonly cwd: string;
  readonly sessionId: string;
};

/**
 * A read-only `SessionManager` over the cached lane read model.
 *
 * The extension runtime is given one view for the harness's lifetime; every
 * method reads the current lane state, so a view handed to an extension at
 * load stays correct as the transcript grows. Nothing here writes: the
 * session belongs to pi's durable harness.
 */
export function createSessionView(
  states: ExtensionLaneStates,
  options: SessionViewOptions
): ReadonlySessionManager {
  const entries = (): SessionEntry[] =>
    states.current.entries.map(projectSessionEntry);
  return {
    getCwd: () => options.cwd,
    getSessionDir: () => options.cwd,
    getSessionId: () => options.sessionId,
    // The transcript is Durable Object storage, not a file on disk.
    getSessionFile: () => undefined,
    getLeafId: () => states.current.tipId,
    getLeafEntry: () => {
      const tipId = states.current.tipId;
      return tipId === null
        ? undefined
        : entries().find((entry) => entry.id === tipId);
    },
    getEntry: (id: string) => entries().find((entry) => entry.id === id),
    // Labels live outside the lane snapshot; nothing vendored reads them back.
    getLabel: () => undefined,
    getBranch: (fromId?: string) => {
      const all = entries();
      if (fromId === undefined) return all;
      const index = all.findIndex((entry) => entry.id === fromId);
      return index < 0 ? all : all.slice(0, index + 1);
    },
    buildContextEntries: () => entries(),
    getHeader: (): SessionHeader => ({
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp: isoTimestamp(Date.now()),
      cwd: options.cwd
    }),
    getEntries: () => entries(),
    getTree: (): SessionTreeNode[] => {
      // The lane snapshot is one branch, so the tree is that single spine.
      const nodes = entries().map(
        (entry): SessionTreeNode => ({ entry, children: [] })
      );
      for (let index = nodes.length - 1; index > 0; index--) {
        nodes[index - 1].children.push(nodes[index]);
      }
      return nodes.length === 0 ? [] : [nodes[0]];
    },
    getSessionName: () => states.current.sessionName
  };
}
