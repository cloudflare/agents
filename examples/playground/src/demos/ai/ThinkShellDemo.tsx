import { useState } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import { CodeExplanation, LogPanel, type CodeSection } from "../../components";
import { useLogs } from "../../hooks";

type LayerId = "think" | "workspace" | "codemode" | "git" | "extensions";

const layers: Array<{
  id: LayerId;
  name: string;
  role: string;
  details: string[];
}> = [
  {
    id: "think",
    name: "Think",
    role: "Opinionated chat loop",
    details: [
      "Owns the AI SDK streamText call",
      "Persists messages in Durable Object SQLite",
      "Supports client tools, resumable streams, and lifecycle hooks"
    ]
  },
  {
    id: "workspace",
    name: "Workspace",
    role: "Durable virtual filesystem",
    details: [
      "Stores files in SQLite with optional R2 spillover",
      "Gives the model read/write/list/search tools",
      "Survives refreshes and follow-up turns"
    ]
  },
  {
    id: "codemode",
    name: "Codemode + Shell",
    role: "Sandboxed state programs",
    details: [
      "Runs JavaScript in an isolated Worker",
      "Exposes state.* instead of shell commands",
      "Lets agents perform multi-file edits transactionally"
    ]
  },
  {
    id: "git",
    name: "Git Tools",
    role: "Version control over virtual files",
    details: [
      "Uses isomorphic-git against the Workspace filesystem",
      "Can inject hidden auth for clone/fetch/push",
      "Keeps secrets out of model-visible tool inputs"
    ]
  },
  {
    id: "extensions",
    name: "Extensions",
    role: "Loadable assistant capabilities",
    details: [
      "Think can load extension manifests",
      "Extensions can provide tools and hook subscriptions",
      "Worker Loader can isolate extension code"
    ]
  }
];

const flow = [
  [
    "user_message",
    { text: "Rename foo to bar across /src and summarize changes" }
  ],
  ["think_before_turn", { contextBlocks: ["workspace tree", "recent files"] }],
  ["workspace_search", { query: "foo", matches: 3 }],
  ["codemode_execute", { code: "state.replaceInFiles(...)", sandboxed: true }],
  ["workspace_diff", { filesChanged: 2 }],
  ["assistant_response", { summary: "Renamed foo to bar in two files." }]
];

const codeSections: CodeSection[] = [
  {
    title: "Use Think when you want a full assistant",
    description:
      "Think is the high-level agent base class: chat protocol, persistence, stream resumption, client tools, workspace tools, and lifecycle hooks.",
    code: `import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

export class Assistant extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }

  getSystemPrompt() {
    return "You are a helpful coding assistant.";
  }
}`
  },
  {
    title: "Back the assistant with a Workspace",
    description:
      "Workspace is a durable virtual filesystem. Think exposes workspace tools automatically, and lower-level agents can wire it into their own tools.",
    code: `import { Workspace } from "@cloudflare/shell";

export class Assistant extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });
}`
  },
  {
    title: "Run structured state programs instead of shell",
    description:
      "Shell is not bash. It runs JavaScript in an isolated Worker and gives code a typed state object for filesystem operations.",
    code: `import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { stateTools } from "@cloudflare/shell/workers";

const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });

await executor.execute(
  \`async () => {
    const preview = await state.replaceInFiles("src/**/*.ts", "foo", "bar", {
      dryRun: true
    });
    return preview;
  }\`,
  [resolveProvider(stateTools(this.workspace))]
);`
  }
];

export function ThinkShellDemo() {
  const [selectedId, setSelectedId] = useState<LayerId>("think");
  const { logs, addLog, clearLogs } = useLogs();
  const selected = layers.find((layer) => layer.id === selectedId) ?? layers[0];

  const simulate = () => {
    clearLogs();
    flow.forEach(([type, payload], index) => {
      window.setTimeout(
        () => addLog("in", type as string, payload),
        index * 300
      );
    });
  };

  return (
    <DemoWrapper
      title="Think + Shell"
      description={
        <>
          Think is the higher-level assistant runtime; Shell and Workspace give
          that assistant durable files and safe structured execution. Together
          they are the SDK path for coding assistants, workspace agents, and
          multi-step tool-using products.
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Assistant Stack
              </Text>
            </div>
            <div className="space-y-2">
              {layers.map((layer) => (
                <button
                  key={layer.id}
                  type="button"
                  onClick={() => setSelectedId(layer.id)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    selectedId === layer.id
                      ? "border-kumo-brand bg-kumo-elevated"
                      : "border-kumo-line hover:border-kumo-interact"
                  }`}
                >
                  <Text bold size="sm">
                    {layer.name}
                  </Text>
                  <p className="mt-1 text-xs text-kumo-subtle">{layer.role}</p>
                </button>
              ))}
            </div>
          </Surface>

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                {selected.name}
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">{selected.role}</p>
            <div className="space-y-2">
              {selected.details.map((detail) => (
                <div key={detail} className="p-3 rounded bg-kumo-elevated">
                  <Text size="sm">{detail}</Text>
                </div>
              ))}
            </div>
          </Surface>
        </div>

        <div className="space-y-6">
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Simulated Workspace Turn
              </Text>
            </div>
            <p className="text-sm text-kumo-subtle mb-4">
              This is the kind of turn Think + Shell is designed for: gather
              context, operate on durable files, run sandboxed state code, then
              return a diff-aware answer.
            </p>
            <Button variant="primary" onClick={simulate}>
              Simulate Workspace Turn
            </Button>
          </Surface>

          <LogPanel logs={logs} onClear={clearLogs} maxHeight="280px" />

          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3" as="h3">
                Full Examples
              </Text>
            </div>
            <div className="space-y-2">
              {[
                ["Assistant product shell", "examples/assistant"],
                ["Workspace chat", "examples/workspace-chat"],
                ["Shell package", "packages/shell"],
                ["Think package", "packages/think"]
              ].map(([label, path]) => (
                <div
                  key={path}
                  className="flex items-center justify-between gap-3 p-3 rounded bg-kumo-elevated"
                >
                  <Text size="sm" bold>
                    {label}
                  </Text>
                  <code className="text-xs text-kumo-subtle">{path}</code>
                </div>
              ))}
            </div>
          </Surface>
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
