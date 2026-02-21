import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import { ModeToggle, PoweredByAgents } from "@cloudflare/agents-ui";
import { Badge, Surface, Text } from "@cloudflare/kumo";
import {
  ChatCircleDotsIcon,
  InfoIcon,
  TerminalIcon,
  CursorClickIcon,
  ArrowSquareOutIcon
} from "@phosphor-icons/react";
import "./styles.css";

const MCP_URL =
  typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";

function App() {
  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ChatCircleDotsIcon
              size={22}
              className="text-kumo-accent"
              weight="bold"
            />
            <h1 className="text-lg font-semibold text-kumo-default">
              MCP Elicitation
            </h1>
            <Badge variant="secondary">v1.0.0</Badge>
          </div>
          <ModeToggle />
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-2xl mx-auto space-y-6">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Elicitation Demo
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This MCP server uses{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      this.elicitInput()
                    </code>{" "}
                    to request additional user input mid-tool-call. When you
                    call the &ldquo;increase-counter&rdquo; tool, the server
                    pauses and asks <em>how much</em> to increase by — the MCP
                    client prompts you and sends the answer back.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          <Surface className="p-6 rounded-xl ring ring-kumo-line text-center">
            <CursorClickIcon
              size={48}
              weight="duotone"
              className="text-kumo-accent mx-auto mb-4"
            />
            <Text size="sm" bold>
              Connect from an MCP client
            </Text>
            <span className="mt-2 block max-w-md mx-auto">
              <Text size="xs" variant="secondary">
                Elicitation requires an MCP client that supports the{" "}
                <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                  elicitation/create
                </code>{" "}
                protocol method. The browser tool tester cannot handle
                elicitation prompts — connect from one of the clients below
                instead.
              </Text>
            </span>

            <div className="mt-6 space-y-2">
              <Surface className="p-3 rounded-lg ring ring-kumo-line text-left">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <TerminalIcon
                      size={20}
                      weight="bold"
                      className="text-kumo-subtle"
                    />
                    <div>
                      <Text size="sm" bold>
                        MCP Inspector
                      </Text>
                      <span className="block">
                        <Text size="xs" variant="secondary">
                          npx @modelcontextprotocol/inspector
                        </Text>
                      </span>
                    </div>
                  </div>
                  <a
                    href="https://github.com/modelcontextprotocol/inspector"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-kumo-accent"
                  >
                    <ArrowSquareOutIcon size={18} />
                  </a>
                </div>
              </Surface>

              <Surface className="p-3 rounded-lg ring ring-kumo-line text-left">
                <div className="flex items-center gap-3">
                  <TerminalIcon
                    size={20}
                    weight="bold"
                    className="text-kumo-subtle"
                  />
                  <div>
                    <Text size="sm" bold>
                      Claude Desktop / Cursor / Windsurf
                    </Text>
                    <span className="block">
                      <Text size="xs" variant="secondary">
                        Add as a remote MCP server
                      </Text>
                    </span>
                  </div>
                </div>
              </Surface>
            </div>

            <Surface className="mt-6 p-3 rounded-lg bg-kumo-elevated text-left">
              <Text size="xs" variant="secondary" bold>
                Server URL
              </Text>
              <pre className="mt-1 text-sm font-mono text-kumo-default select-all">
                {MCP_URL}
              </pre>
            </Surface>
          </Surface>
        </div>
      </main>

      <footer className="border-t border-kumo-line py-3">
        <div className="flex justify-center">
          <PoweredByAgents />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
