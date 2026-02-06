import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import "./styles.css";

// Lazy-load demos to keep bundles separate
import ChatApp from "./client";

type DemoType = "chat" | "editor" | "assistant";

const DEMOS: { id: DemoType; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "editor", label: "Editor" },
  { id: "assistant", label: "Assistant" }
];

function DemoSwitcher() {
  const [demo, setDemo] = useState<DemoType>(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("demo");
    if (d === "editor" || d === "assistant") return d;
    return "chat";
  });

  // Lazy import the editor and assistant only when needed
  const [EditorApp, setEditorApp] = useState<React.ComponentType | null>(null);
  const [AssistantApp, setAssistantApp] = useState<React.ComponentType | null>(
    null
  );

  useEffect(() => {
    if (demo === "editor" && !EditorApp) {
      import("./editor").then((mod) => setEditorApp(() => mod.default));
    }
    if (demo === "assistant" && !AssistantApp) {
      import("./assistant").then((mod) => setAssistantApp(() => mod.default));
    }
  }, [demo, EditorApp, AssistantApp]);

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
        {DEMOS.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => setDemo(d.id)}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              demo === d.id
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300"
            }`}
          >
            {d.label}
          </button>
        ))}
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
        {demo === "assistant" &&
          (AssistantApp ? (
            <AssistantApp />
          ) : (
            <div className="flex items-center justify-center h-[calc(100vh-2.25rem)] bg-zinc-950 text-zinc-400">
              Loading assistant...
            </div>
          ))}
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<DemoSwitcher />);
