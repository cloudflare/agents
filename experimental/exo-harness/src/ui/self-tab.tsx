import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CloudArrowUpIcon,
  FileIcon,
  GitCommitIcon
} from "@phosphor-icons/react";
import type { ExoState } from "../kernel/types";
import { formatBytes, formatTime, shortSha, type AgentCaller } from "./bits";

/**
 * The "Self" tab — the agent's own evolvable source (live /harness files)
 * plus its version timeline. Selecting an old version shows that version's
 * snapshot; "Restore" rolls the harness back (forward-only, as a new
 * version).
 */
export function SelfTab({
  agent,
  state,
  isConnected
}: {
  agent: AgentCaller;
  state: ExoState;
  isConnected: boolean;
}) {
  // null = viewing the live working tree; a number = viewing that version.
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [versionFiles, setVersionFiles] = useState<Record<
    string,
    string
  > | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const viewingLive = viewVersion === null;

  const openVersion = useCallback(
    async (version: number | null) => {
      setViewVersion(version);
      setSelectedPath(null);
      setFileContent(null);
      if (version === null) {
        setVersionFiles(null);
        return;
      }
      const files = (await agent.call("getVersionFiles", [version])) as Record<
        string,
        string
      > | null;
      setVersionFiles(files);
    },
    [agent]
  );

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      if (viewingLive) {
        const content = (await agent.call("getFileContent", [path])) as
          | string
          | null;
        setFileContent(content);
      } else {
        setFileContent(versionFiles?.[path] ?? null);
      }
    },
    [agent, viewingLive, versionFiles]
  );

  // Live view follows state updates: re-read the open file when the agent
  // rewrites itself mid-conversation.
  useEffect(() => {
    if (!viewingLive || !selectedPath || !isConnected) return;
    let cancelled = false;
    void agent
      .call("getFileContent", [selectedPath])
      .then((content) => {
        if (!cancelled) setFileContent(content as string | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent, viewingLive, selectedPath, isConnected, state.journalTail]);

  const rollback = useCallback(
    async (version: number) => {
      setRollingBack(true);
      try {
        await agent.call("rollbackFromUi", [version]);
        setViewVersion(null);
        setVersionFiles(null);
      } finally {
        setRollingBack(false);
      }
    },
    [agent]
  );

  const filePaths = viewingLive
    ? state.harnessFiles.map((f) => f.path)
    : Object.keys(versionFiles ?? {}).sort();

  // The agent's Artifacts mirror, from the most recent pushed version.
  const artifactsRemote = [...state.versions]
    .reverse()
    .find((v) => v.remote)?.remote;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Version timeline */}
      <div className="border-b border-kumo-line shrink-0 max-h-[35%] overflow-y-auto">
        <div className="px-3 py-2 flex items-center gap-2">
          <GitCommitIcon size={14} className="text-kumo-accent" />
          <Text size="xs" bold>
            Version timeline
          </Text>
          {artifactsRemote && (
            <span
              className="flex items-center gap-1 min-w-0 ml-auto"
              title={`Mirrored to Cloudflare Artifacts: ${artifactsRemote}`}
            >
              <CloudArrowUpIcon
                size={13}
                className="text-kumo-accent shrink-0"
              />
              <span className="text-[10px] font-mono text-kumo-inactive truncate">
                {artifactsRemote.replace(/^https:\/\//, "")}
              </span>
            </span>
          )}
        </div>
        {[...state.versions].reverse().map((v) => {
          const isActive = v.version === state.activeVersion;
          const isViewing = viewVersion === v.version;
          return (
            <div
              key={v.version}
              className={`px-3 py-1.5 flex items-center gap-2 border-t border-kumo-line ${
                isViewing ? "bg-kumo-elevated" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => openVersion(isViewing ? null : v.version)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                title={`Inspect v${v.version} snapshot`}
              >
                <Badge variant={isActive ? "primary" : "secondary"}>
                  v{v.version}
                </Badge>
                <span className="text-xs text-kumo-default truncate flex-1">
                  {v.note}
                </span>
                <span className="text-[10px] font-mono text-kumo-inactive shrink-0">
                  {shortSha(v.sha)}
                </span>
                {v.remote && (
                  <span
                    className="shrink-0 flex"
                    title={`Pushed ${shortSha(v.pushedSha ?? v.sha)} to ${v.remote}`}
                  >
                    <CloudArrowUpIcon size={13} className="text-kumo-accent" />
                  </span>
                )}
                <span className="text-[10px] text-kumo-inactive shrink-0">
                  {formatTime(v.ts)}
                </span>
              </button>
              {!isActive && (
                <Button
                  variant="ghost"
                  shape="square"
                  aria-label={`Restore v${v.version}`}
                  loading={rollingBack}
                  onClick={() => rollback(v.version)}
                  icon={<ArrowCounterClockwiseIcon size={13} />}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Harness files */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-kumo-line shrink-0">
        <Text size="xs" bold>
          {viewingLive
            ? "Live harness (hot-loaded every turn)"
            : `Snapshot of v${viewVersion}`}
        </Text>
        {!viewingLive && (
          <Button variant="ghost" size="sm" onClick={() => openVersion(null)}>
            back to live
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {filePaths.map((path) => {
          const live = state.harnessFiles.find((f) => f.path === path);
          return (
            <button
              key={path}
              type="button"
              onClick={() => openFile(path)}
              className={`w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left cursor-pointer ${
                selectedPath === path ? "bg-kumo-elevated" : ""
              }`}
            >
              <FileIcon size={13} className="text-kumo-subtle shrink-0" />
              <span className="text-xs font-mono text-kumo-default truncate flex-1">
                {path.replace("/harness/", "")}
              </span>
              {live && (
                <span className="text-[10px] text-kumo-inactive shrink-0">
                  {formatBytes(live.size)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* File viewer */}
      {selectedPath && (
        <div className="border-t border-kumo-line flex flex-col max-h-[45%] shrink-0">
          <div className="px-3 py-1.5 flex items-center justify-between border-b border-kumo-line bg-kumo-elevated">
            <span className="text-[10px] font-mono text-kumo-default truncate">
              {selectedPath}
              {!viewingLive && ` @ v${viewVersion}`}
            </span>
            <button
              type="button"
              onClick={() => {
                setSelectedPath(null);
                setFileContent(null);
              }}
              className="text-kumo-inactive hover:text-kumo-default text-xs cursor-pointer"
            >
              ×
            </button>
          </div>
          <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed font-mono text-kumo-default bg-kumo-base whitespace-pre-wrap break-all">
            {fileContent ?? "(missing)"}
          </pre>
        </div>
      )}
    </div>
  );
}
