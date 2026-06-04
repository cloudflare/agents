import { useState } from "react";
import { PoweredByCloudflare } from "@cloudflare/kumo";
import { DEFAULT_SCRIPT } from "./sampleScripts";
import { useBrowserSession } from "./hooks/useBrowserSession";
import { Explainer } from "./components/Explainer";
import { Header } from "./components/Header";
import { LiveViewPanel } from "./components/LiveViewPanel";
import { OutputPanel } from "./components/OutputPanel";
import { ScriptEditor } from "./components/ScriptEditor";
import { SessionHome } from "./components/SessionHome";

export function App() {
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const browserSession = useBrowserSession();

  return (
    <div className="min-h-screen bg-kumo-elevated text-kumo-default">
      <Header />

      <main className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6">
        <Explainer />

        {browserSession.selectedSession ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <ScriptEditor
              script={script}
              running={browserSession.running}
              stopping={browserSession.stopping}
              hasSession={!!browserSession.selectedSession}
              onScriptChange={setScript}
              onRun={() => browserSession.run(script)}
              onStop={browserSession.stop}
            />

            <div className="flex flex-col gap-5">
              <LiveViewPanel browserSession={browserSession} />
              <OutputPanel
                error={browserSession.error}
                runResponse={browserSession.runResponse}
              />
            </div>
          </div>
        ) : (
          <SessionHome browserSession={browserSession} />
        )}
      </main>

      <footer className="mx-auto max-w-7xl px-5 pb-6">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}
