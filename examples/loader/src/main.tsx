import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import "./styles.css";

// Lazy-load demos to keep bundles separate
import ChatApp from "./client";

function DemoSwitcher() {
  const [demo, setDemo] = useState<"chat" | "editor">(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("demo");
    if (d === "editor") return "editor";
    return "chat";
  });

  // Lazy import the editor only when needed
  const [EditorApp, setEditorApp] = useState<React.ComponentType | null>(null);

  useEffect(() => {
    if (demo === "editor" && !EditorApp) {
      import("./editor").then((mod) => setEditorApp(() => mod.default));
    }
  }, [demo, EditorApp]);

  // Sync URL with demo state
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("demo", demo);
    window.history.replaceState({}, "", url.toString());
  }, [demo]);

  return (
    <>
      {/* Demo switcher tab bar */}
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center gap-1 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
        <span className="text-zinc-500 text-xs font-medium mr-2 select-none">
          Think Demos
        </span>
        <button
          type="button"
          onClick={() => setDemo("chat")}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            demo === "chat"
              ? "bg-blue-600 text-white"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
          }`}
        >
          Chat
        </button>
        <button
          type="button"
          onClick={() => setDemo("editor")}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            demo === "editor"
              ? "bg-blue-600 text-white"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
          }`}
        >
          Editor
        </button>
      </div>

      {/* Demo content - offset by tab bar height */}
      <div className="pt-9">
        {demo === "chat" && <ChatApp />}
        {demo === "editor" &&
          (EditorApp ? (
            <EditorApp />
          ) : (
            <div className="flex items-center justify-center h-[calc(100vh-2.25rem)] bg-zinc-950 text-zinc-400">
              Loading editor...
            </div>
          ))}
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<DemoSwitcher />);
