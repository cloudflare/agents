import type { UIMessageChunk } from "ai";
import type { JournalEntry } from "../types";

/**
 * Resuming a streaming turn re-runs a replay-style connector (one that
 * observes a durable remote stream from a checkpointed offset).
 * The connector's checkpoint always trails the journal, so the resumed
 * stream re-emits a short overlap of chunks the journal already holds.
 * This module keeps that overlap out of the journal: what a client replays
 * is each visible byte exactly once.
 *
 * Part ids may differ between the original run and the re-run (projection
 * counters restart), so the overlap is matched by *content*: cumulative
 * visible text per kind, and `type:toolCallId` for tool events. Parts the
 * crash left open are closed first; the continuation opens fresh parts
 * under aliased ids so they can never collide with ids the journal
 * already closed.
 */

type StreamedKind = "text" | "reasoning";

interface DeltaChunk {
  type: "text-delta" | "reasoning-delta";
  id: string;
  delta: string;
}

interface PartBoundaryChunk {
  type: "text-start" | "text-end" | "reasoning-start" | "reasoning-end";
  id: string;
}

export interface ResumePlan {
  /** Filter one re-emitted chunk into the chunks that may be journaled. */
  filter(chunk: UIMessageChunk): UIMessageChunk[];
}

/** `text-end`/`reasoning-end` chunks for every part the journal left open. */
export function openPartEnds(journal: JournalEntry[]): UIMessageChunk[] {
  const open = new Map<string, StreamedKind>();
  for (const { chunk } of journal) {
    const kind = kindOfBoundary(chunk.type);
    if (!kind) {
      continue;
    }
    const { id } = chunk as PartBoundaryChunk;
    if (chunk.type.endsWith("-start")) {
      open.set(id, kind);
    } else {
      open.delete(id);
    }
  }
  return [...open].map(([id, kind]) => ({
    id,
    type: kind === "text" ? "text-end" : "reasoning-end"
  }));
}

export function planResume(journal: JournalEntry[]): ResumePlan {
  // How much visible text of each kind the journal already holds — the
  // amount of re-emitted content to swallow before passing chunks through.
  const remaining: Record<StreamedKind, number> = { reasoning: 0, text: 0 };
  const seenToolEvents = new Set<string>();
  // Chunks with no positional identity (data-*, file, source-*) dedupe by
  // exact content: a replay re-emits them byte-identical, and letting one
  // through twice would double it on every client replay.
  const seenOtherChunks = new Set<string>();
  for (const { chunk } of journal) {
    const kind = kindOfDelta(chunk.type);
    if (kind) {
      remaining[kind] += (chunk as DeltaChunk).delta.length;
      continue;
    }
    const toolEvent = toolEventKey(chunk);
    if (toolEvent) {
      seenToolEvents.add(toolEvent);
      continue;
    }
    if (!kindOfBoundary(chunk.type)) {
      seenOtherChunks.add(JSON.stringify(chunk));
    }
  }

  // Continuation parts get aliased ids, unique to this resume, so they
  // never collide with part ids the pre-crash journal already used.
  // Uniqueness leans on prepareJournalForRun appending part-end frames
  // before every re-run: consecutive resumes therefore always see a
  // longer journal and get a fresh suffix.
  const aliasSuffix = `~r${journal.length}`;
  const alias = (id: string) => `${id}${aliasSuffix}`;

  // Part ids (already aliased) whose start frame has been passed through
  // or synthesized, so end frames of swallowed parts are dropped and
  // every passed delta has a well-formed opening.
  const startedIds = new Set<string>();

  return {
    filter(chunk: UIMessageChunk): UIMessageChunk[] {
      const boundaryKind = kindOfBoundary(chunk.type);
      if (boundaryKind) {
        const id = alias((chunk as PartBoundaryChunk).id);
        if (chunk.type.endsWith("-start")) {
          if (remaining[boundaryKind] > 0) {
            return [];
          }
          startedIds.add(id);
          return [{ ...chunk, id } as UIMessageChunk];
        }
        return startedIds.has(id) ? [{ ...chunk, id } as UIMessageChunk] : [];
      }

      const deltaKind = kindOfDelta(chunk.type);
      if (deltaKind) {
        const { delta } = chunk as DeltaChunk;
        const id = alias((chunk as DeltaChunk).id);
        if (remaining[deltaKind] >= delta.length) {
          remaining[deltaKind] -= delta.length;
          return [];
        }
        const fresh = delta.slice(remaining[deltaKind]);
        remaining[deltaKind] = 0;
        const out: UIMessageChunk[] = [];
        if (!startedIds.has(id)) {
          startedIds.add(id);
          out.push({
            id,
            type: deltaKind === "text" ? "text-start" : "reasoning-start"
          });
        }
        out.push({ ...chunk, delta: fresh, id } as UIMessageChunk);
        return out;
      }

      const toolEvent = toolEventKey(chunk);
      if (toolEvent) {
        if (seenToolEvents.has(toolEvent)) {
          return [];
        }
        seenToolEvents.add(toolEvent);
        return [chunk];
      }

      const key = JSON.stringify(chunk);
      if (seenOtherChunks.has(key)) {
        return [];
      }
      seenOtherChunks.add(key);
      return [chunk];
    }
  };
}

function kindOfDelta(type: string): StreamedKind | undefined {
  if (type === "text-delta") {
    return "text";
  }
  if (type === "reasoning-delta") {
    return "reasoning";
  }
  return undefined;
}

function kindOfBoundary(type: string): StreamedKind | undefined {
  if (type === "text-start" || type === "text-end") {
    return "text";
  }
  if (type === "reasoning-start" || type === "reasoning-end") {
    return "reasoning";
  }
  return undefined;
}

function toolEventKey(chunk: UIMessageChunk): string | undefined {
  const candidate = chunk as { type: string; toolCallId?: string };
  return candidate.type.startsWith("tool-") && candidate.toolCallId
    ? `${candidate.type}:${candidate.toolCallId}`
    : undefined;
}
