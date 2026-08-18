import { useCallback, useEffect, useState } from "react";
import { FileIcon, FolderIcon, FolderOpenIcon } from "@phosphor-icons/react";
import type { ExoState } from "../kernel/types";
import { formatBytes, type AgentCaller } from "./bits";

interface Entry {
  path: string;
  name: string;
  type: string;
  size: number;
}

/**
 * Plain file browser over the whole durable Workspace — shows harness AND
 * scratch space, so shell-tool side effects are visible as they land.
 */
export function WorkspaceTab({
  agent,
  state,
  isConnected
}: {
  agent: AgentCaller;
  state: ExoState;
  isConnected: boolean;
}) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<{
    path: string;
    content: string | null;
  } | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      if (!isConnected) return;
      try {
        const result = (await agent.call("listWorkspaceFiles", [
          path
        ])) as Entry[];
        setEntries(result);
        setCurrentPath(path);
      } catch {
        setEntries([]);
      }
    },
    [agent, isConnected]
  );

  // Refresh the listing whenever the journal moves (i.e. anything happened).
  useEffect(() => {
    void loadDir(currentPath);
  }, [loadDir, currentPath, state.journalTail]);

  const openEntry = useCallback(
    async (entry: Entry) => {
      if (entry.type === "directory") {
        setSelected(null);
        await loadDir(entry.path);
        return;
      }
      const content = (await agent.call("getFileContent", [entry.path])) as
        | string
        | null;
      setSelected({ path: entry.path, content });
    },
    [agent, loadDir]
  );

  const parent =
    currentPath === "/"
      ? null
      : currentPath.split("/").slice(0, -1).join("/") || "/";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-kumo-line flex items-center gap-2 shrink-0">
        <FolderOpenIcon size={14} className="text-kumo-accent" />
        <span className="text-xs font-mono text-kumo-default">
          {currentPath}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {parent !== null && (
          <button
            type="button"
            onClick={() => loadDir(parent)}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left cursor-pointer"
          >
            <FolderIcon size={13} className="text-kumo-subtle shrink-0" />
            <span className="text-xs text-kumo-default">..</span>
          </button>
        )}
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => openEntry(entry)}
            className={`w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left cursor-pointer ${
              selected?.path === entry.path ? "bg-kumo-elevated" : ""
            }`}
          >
            {entry.type === "directory" ? (
              <FolderIcon size={13} className="text-kumo-accent shrink-0" />
            ) : (
              <FileIcon size={13} className="text-kumo-subtle shrink-0" />
            )}
            <span className="text-xs text-kumo-default truncate flex-1">
              {entry.name}
            </span>
            {entry.type === "file" && (
              <span className="text-[10px] text-kumo-inactive shrink-0">
                {formatBytes(entry.size)}
              </span>
            )}
          </button>
        ))}
      </div>
      {selected && (
        <div className="border-t border-kumo-line flex flex-col max-h-[45%] shrink-0">
          <div className="px-3 py-1.5 flex items-center justify-between border-b border-kumo-line bg-kumo-elevated">
            <span className="text-[10px] font-mono text-kumo-default truncate">
              {selected.path}
            </span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-kumo-inactive hover:text-kumo-default text-xs cursor-pointer"
            >
              ×
            </button>
          </div>
          <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed font-mono text-kumo-default bg-kumo-base whitespace-pre-wrap break-all">
            {selected.content ?? "(binary or missing)"}
          </pre>
        </div>
      )}
    </div>
  );
}
