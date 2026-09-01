import {
  Badge,
  Button,
  Empty,
  Input,
  PoweredByCloudflare,
  Surface,
  Text,
  Textarea
} from "@cloudflare/kumo";
import {
  CubeIcon,
  MoonIcon,
  PlayIcon,
  PlusIcon,
  ProhibitIcon,
  RocketLaunchIcon,
  SunIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { DEFAULT_GADGET_CODE, type GadgetInfo } from "./shared";
import "./styles.css";

const INSTANCE_KEY = "next-dynamic-agents-instance";
const instanceName =
  localStorage.getItem(INSTANCE_KEY) ?? crypto.randomUUID().slice(0, 8);
localStorage.setItem(INSTANCE_KEY, instanceName);

type LogEntry = { at: number; label: string; body: string };

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function App() {
  const supervisor = useAgent({ agent: "supervisor", name: instanceName });
  const [gadgets, setGadgets] = useState<GadgetInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [code, setCode] = useState(DEFAULT_GADGET_CODE);
  const [path, setPath] = useState("/counter");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const append = useCallback((label: string, body: unknown) => {
    setLog((entries) => [
      {
        at: Date.now(),
        label,
        body: typeof body === "string" ? body : JSON.stringify(body, null, 2)
      },
      ...entries.slice(0, 49)
    ]);
  }, []);

  const refresh = useCallback(async () => {
    setGadgets((await supervisor.call("listGadgets")) as GadgetInfo[]);
  }, [supervisor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        const result = await fn();
        if (result !== undefined) append(label, result);
        await refresh();
      } catch (error) {
        append(
          `${label} failed`,
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        setBusy(false);
      }
    },
    [append, refresh]
  );

  const createGadget = () => {
    const name = newName.trim();
    if (!name) return;
    void run(`create ${name}`, async () => {
      const created = await supervisor.call("createGadget", [name]);
      setSelected(name);
      setNewName("");
      return created;
    });
  };

  const selectedVersion = gadgets.find((g) => g.name === selected)?.version;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Text bold>Dynamic agents</Text>
          <Badge variant="secondary">user code → facet</Badge>
          <Badge variant="secondary">supervisor {instanceName}</Badge>
        </div>
        <ModeToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 flex-col border-r border-kumo-line">
          <div className="flex items-center gap-2 p-3">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
              placeholder="New gadget name…"
              className="flex-1"
              onKeyDown={(event) => event.key === "Enter" && createGadget()}
            />
            <Button
              variant="primary"
              shape="square"
              aria-label="Create gadget"
              disabled={busy || newName.trim() === ""}
              onClick={createGadget}
              icon={<PlusIcon size={16} />}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {gadgets.length === 0 ? (
              <div className="p-4">
                <Text size="sm" variant="secondary">
                  No gadgets yet. Each one runs your code in its own facet: its
                  own isolate, its own SQLite, no wrangler binding.
                </Text>
              </div>
            ) : (
              gadgets.map((gadget) => (
                <button
                  type="button"
                  key={gadget.name}
                  onClick={() => setSelected(gadget.name)}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left hover:bg-kumo-elevated ${
                    selected === gadget.name ? "bg-kumo-elevated" : ""
                  }`}
                >
                  <Text size="sm" bold>
                    {gadget.name}
                  </Text>
                  <Badge variant="secondary">v{gadget.version}</Badge>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-kumo-line p-3">
            <PoweredByCloudflare />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1">
          {selected ? (
            <>
              <section className="flex min-w-0 flex-1 flex-col border-r border-kumo-line">
                <div className="flex items-center justify-between border-b border-kumo-line px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Text size="sm" bold>
                      {selected}
                    </Text>
                    {selectedVersion !== undefined && (
                      <Badge variant="secondary">v{selectedVersion}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(`deploy ${selected}`, () =>
                          supervisor.call("updateGadgetCode", [selected, code])
                        )
                      }
                      icon={<RocketLaunchIcon size={14} />}
                    >
                      Deploy new version
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(`abort ${selected}`, () =>
                          supervisor.call("abortGadget", [selected])
                        )
                      }
                      icon={<ProhibitIcon size={14} />}
                    >
                      Abort
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        void run(`delete ${selected}`, () =>
                          supervisor.call("deleteGadget", [selected])
                        );
                        setSelected(null);
                      }}
                      icon={<TrashIcon size={14} />}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                <Textarea
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs"
                />
                <div className="border-t border-kumo-line p-3">
                  <Text size="xs" variant="secondary">
                    Deploying aborts the facet and loads the new class over the
                    SAME storage — bump the "version" string in the code, hit
                    Deploy, then Invoke: the hit counter keeps counting.
                  </Text>
                </div>
              </section>

              <section className="flex w-96 flex-col">
                <form
                  className="flex gap-2 border-b border-kumo-line p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(`invoke ${selected}${path}`, () =>
                      supervisor.call("invokeGadget", [selected, path])
                    );
                  }}
                >
                  <Input
                    value={path}
                    onChange={(event) => setPath(event.currentTarget.value)}
                    placeholder="/path"
                    className="flex-1 font-mono"
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={busy}
                    icon={<PlayIcon size={16} />}
                  >
                    Invoke
                  </Button>
                </form>
                <div className="flex-1 space-y-2 overflow-y-auto p-3">
                  {log.map((entry) => (
                    <Surface
                      key={entry.at + entry.label}
                      className="rounded-lg p-2"
                    >
                      <div>
                        <Text size="xs" variant="secondary">
                          {entry.label}
                        </Text>
                      </div>
                      <pre className="overflow-x-auto font-mono text-xs">
                        {entry.body}
                      </pre>
                    </Surface>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <Empty
                icon={<CubeIcon size={24} />}
                title="Create or pick a gadget"
                description="The supervisor stores your code, loads it with Worker Loader, and mounts the exported Sandbox class as a facet — durable, isolated storage for code that has no wrangler binding."
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
