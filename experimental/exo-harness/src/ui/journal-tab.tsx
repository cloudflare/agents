import { Badge, Empty, Text } from "@cloudflare/kumo";
import { ScrollIcon } from "@phosphor-icons/react";
import type { ExoState, JournalEntry, JournalKind } from "../kernel/types";
import { formatTime } from "./bits";

const KIND_STYLE: Record<
  JournalKind,
  { variant: "primary" | "secondary" | "destructive"; label?: string }
> = {
  genesis: { variant: "primary" },
  turn_start: { variant: "secondary" },
  turn_end: { variant: "secondary" },
  tool_call: { variant: "secondary" },
  tool_result: { variant: "secondary" },
  harness_upgrade: { variant: "primary" },
  harness_rollback: { variant: "destructive" },
  harness_load_failed: { variant: "destructive" },
  artifacts_push: { variant: "primary" },
  artifacts_push_failed: { variant: "destructive" },
  fork: { variant: "primary" },
  history_compacted: { variant: "primary" },
  file_write: { variant: "secondary" },
  file_delete: { variant: "secondary" },
  note: { variant: "primary" },
  error: { variant: "destructive" }
};

function summarize(entry: JournalEntry): string {
  const d = entry.data;
  switch (entry.kind) {
    case "genesis":
      return `v${d.version} · ${String(d.sha).slice(0, 7)}${
        d.parent ? ` · fork of ${String(d.parent)} v${d.parentVersion}` : ""
      }`;
    case "fork":
      return `→ ${String(d.child)} (${String(d.origin)}) as v${d.childVersion} from v${d.fromVersion}`;
    case "history_compacted":
      return d.phase === "requested"
        ? `requested · ${String(d.summaryChars)}ch summary → ${String(d.memoryFile)}, keep last ${d.keepLast}`
        : `applied · dropped ${d.dropped}, kept last ${d.keptLast}`;
    case "harness_upgrade":
      return `v${d.version} · ${String(d.note)}`;
    case "harness_rollback":
      return `to v${d.toVersion}${d.asVersion ? ` as v${d.asVersion}` : ""} (${String(d.reason)})`;
    case "harness_load_failed":
      return String(d.error);
    case "artifacts_push":
      return `v${d.version} · ${String(d.sha).slice(0, 7)} → ${String(d.remote)}`;
    case "artifacts_push_failed":
      return `v${d.version}: ${String(d.error)}`;
    case "tool_call":
      return `${String(d.tool)} ${String(d.input ?? "")}`;
    case "tool_result":
      return `${String(d.tool)} ${d.ok ? "ok" : "FAILED"} ${String(d.output ?? d.error ?? "")}`;
    case "file_write":
      return `${String(d.path)} (${String(d.bytes)}B)`;
    case "file_delete":
      return String(d.path);
    case "note":
      return `${String(d.text)} — ${String(d.source)}`;
    case "turn_start":
      return `${String(d.source)} @ v${d.version}`;
    case "turn_end":
      return String(d.source);
    case "error":
      return String(d.message);
    default: {
      const _exhaustive: never = entry.kind;
      return JSON.stringify(d);
    }
  }
}

/**
 * The append-only journal, newest first. This is the one thing the agent can
 * never rewrite — upgrades, rollbacks, and failures all stay on the record.
 */
export function JournalTab({ state }: { state: ExoState }) {
  const entries = [...state.journalTail].reverse();
  if (entries.length === 0) {
    return (
      <Empty
        icon={<ScrollIcon size={32} />}
        title="No journal entries yet"
        description="Every turn, tool call, upgrade, and rollback lands here — append-only."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      {entries.map((entry) => {
        const style = KIND_STYLE[entry.kind] ?? { variant: "secondary" };
        return (
          <div
            key={entry.id}
            className="px-3 py-1.5 border-b border-kumo-line flex items-start gap-2"
          >
            <span className="text-[10px] font-mono text-kumo-inactive shrink-0 mt-0.5 w-8 text-right">
              #{entry.id}
            </span>
            <span className="shrink-0">
              <Badge variant={style.variant}>{entry.kind}</Badge>
            </span>
            <span
              className="text-[11px] font-mono text-kumo-subtle flex-1 break-all"
              title={JSON.stringify(entry.data, null, 2)}
            >
              {summarize(entry)}
            </span>
            <span className="text-[10px] text-kumo-inactive shrink-0">
              {formatTime(entry.ts)}
            </span>
          </div>
        );
      })}
      <div className="px-3 py-2">
        <Text size="xs" variant="secondary">
          Showing the last {entries.length} entries (append-only; the agent
          cannot rewrite this log).
        </Text>
      </div>
    </div>
  );
}
