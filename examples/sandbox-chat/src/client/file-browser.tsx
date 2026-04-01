import {
  useCallback,
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef
} from "react";
import { Button, Empty, Text } from "@cloudflare/kumo";
import {
  FolderIcon,
  FileIcon,
  FolderOpenIcon,
  ArrowCounterClockwiseIcon
} from "@phosphor-icons/react";

type FileEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  path: string;
};

export type FileBrowserHandle = {
  refresh: () => void;
  notifyChange: (path: string) => void;
};

export const FileBrowser = forwardRef<
  FileBrowserHandle,
  {
    agent: { call: (method: string, args: unknown[]) => Promise<unknown> };
    isConnected: boolean;
  }
>(function FileBrowser({ agent, isConnected }, ref) {
  const [currentPath, setCurrentPath] = useState("/workspace");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [info, setInfo] = useState<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
  } | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      if (!isConnected) return;
      setLoading(true);
      try {
        const result = (await agent.call("listFiles", [
          path
        ])) as unknown as Array<{
          name: string;
          type: "file" | "directory" | "symlink";
          size: number;
          path: string;
        }>;
        setEntries(result);
        setCurrentPath(path);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [agent, isConnected]
  );

  const loadInfo = useCallback(async () => {
    if (!isConnected) return;
    try {
      const result = (await agent.call("getWorkspaceInfo", [])) as unknown as {
        fileCount: number;
        directoryCount: number;
        totalBytes: number;
      };
      setInfo(result);
    } catch {
      // ignore
    }
  }, [agent, isConnected]);

  useEffect(() => {
    if (isConnected) {
      loadDir(currentPath);
      loadInfo();
    }
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    loadDir(currentPath);
    loadInfo();
  }, [loadDir, loadInfo, currentPath]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notifyChange = useCallback(
    (changedPath: string) => {
      // Only refresh if the changed path is inside the current directory
      const dir =
        changedPath.substring(0, changedPath.lastIndexOf("/")) || "/workspace";
      if (changedPath.startsWith(currentPath) || dir === currentPath) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          refresh();
          debounceRef.current = null;
        }, 300);
      }
    },
    [currentPath, refresh]
  );

  useImperativeHandle(ref, () => ({ refresh, notifyChange }), [
    refresh,
    notifyChange
  ]);

  const navigateTo = (path: string) => {
    setSelectedFile(null);
    loadDir(path);
    loadInfo();
  };

  const openFile = useCallback(
    async (path: string) => {
      if (!isConnected) return;
      try {
        const content = (await agent.call("readFileContent", [
          path
        ])) as unknown as string | null;
        setSelectedFile({
          path,
          content: content ?? "(empty file)"
        });
      } catch {
        setSelectedFile({ path, content: "(error reading file)" });
      }
    },
    [agent, isConnected]
  );

  const parentPath =
    currentPath === "/workspace"
      ? null
      : currentPath.split("/").slice(0, -1).join("/") || "/workspace";

  const dirs = entries.filter((e) => e.type === "directory");
  const files = entries.filter((e) => e.type !== "directory");

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-kumo-line flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpenIcon size={14} className="text-kumo-accent shrink-0" />
          <span className="text-xs font-mono text-kumo-default truncate">
            {currentPath}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="Refresh"
          icon={<ArrowCounterClockwiseIcon size={12} />}
          onClick={refresh}
          disabled={loading}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center">
            <Text size="xs" variant="secondary">
              Loading...
            </Text>
          </div>
        ) : entries.length === 0 && currentPath === "/workspace" ? (
          <div className="p-4 text-center">
            <Empty
              icon={<FolderIcon size={24} />}
              title="Sandbox is empty"
              description="Ask the AI to create some files"
            />
          </div>
        ) : (
          <div className="py-1">
            {parentPath !== null && (
              <button
                type="button"
                onClick={() => navigateTo(parentPath)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left"
              >
                <FolderIcon size={14} className="text-kumo-accent shrink-0" />
                <span className="text-xs text-kumo-subtle">..</span>
              </button>
            )}
            {dirs.map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left"
              >
                <FolderIcon size={14} className="text-kumo-accent shrink-0" />
                <span className="text-xs text-kumo-default truncate">
                  {entry.name}
                </span>
              </button>
            ))}
            {files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => openFile(entry.path)}
                className={`w-full px-3 py-1.5 flex items-center gap-2 hover:bg-kumo-elevated text-left ${
                  selectedFile?.path === entry.path ? "bg-kumo-elevated" : ""
                }`}
              >
                <FileIcon size={14} className="text-kumo-subtle shrink-0" />
                <span className="text-xs text-kumo-default truncate flex-1">
                  {entry.name}
                </span>
                <span className="text-[10px] text-kumo-inactive shrink-0">
                  {entry.size > 1024
                    ? `${(entry.size / 1024).toFixed(1)}K`
                    : `${entry.size}B`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedFile && (
        <div className="border-t border-kumo-line flex flex-col max-h-[40%]">
          <div className="px-3 py-1.5 flex items-center justify-between border-b border-kumo-line bg-kumo-elevated">
            <span className="text-[10px] font-mono text-kumo-default truncate">
              {selectedFile.path.split("/").pop()}
            </span>
            <button
              type="button"
              onClick={() => setSelectedFile(null)}
              className="text-kumo-inactive hover:text-kumo-default text-xs"
            >
              ×
            </button>
          </div>
          <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] leading-relaxed font-mono text-kumo-default bg-kumo-base whitespace-pre-wrap break-all">
            {selectedFile.content}
          </pre>
        </div>
      )}

      {info && (info.fileCount > 0 || info.directoryCount > 0) && (
        <div className="px-3 py-2 border-t border-kumo-line">
          <span className="text-[10px] text-kumo-inactive">
            {info.fileCount} file{info.fileCount !== 1 ? "s" : ""},{" "}
            {info.directoryCount} dir{info.directoryCount !== 1 ? "s" : ""},{" "}
            {info.totalBytes > 1024
              ? `${(info.totalBytes / 1024).toFixed(1)} KB`
              : `${info.totalBytes} B`}
          </span>
        </div>
      )}
    </div>
  );
});
