import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@cloudflare/agents-ui/hooks";
import { ModeToggle, PoweredByAgents } from "@cloudflare/agents-ui";
import { Badge, Surface, Text } from "@cloudflare/kumo";
import {
  ShieldCheckIcon,
  WrenchIcon,
  GlobeIcon,
  TerminalIcon,
  InfoIcon
} from "@phosphor-icons/react";
import "./styles.css";

const TOOLS = [
  {
    name: "hello",
    description:
      "Returns a greeting — uses the authenticated username if no name is provided"
  },
  {
    name: "whoami",
    description:
      "Returns the authenticated user's profile (userId, username, email)"
  }
];

const ENDPOINTS = [
  {
    path: "/mcp",
    description: "MCP server endpoint (requires Bearer token)"
  },
  {
    path: "/.well-known/oauth-authorization-server",
    description: "OAuth server metadata (discovery)"
  },
  {
    path: "/oauth/register",
    description: "Dynamic client registration"
  },
  { path: "/authorize", description: "OAuth authorization" },
  { path: "/oauth/token", description: "Token exchange" }
];

function App() {
  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheckIcon
              size={22}
              className="text-kumo-accent"
              weight="bold"
            />
            <h1 className="text-lg font-semibold text-kumo-default">
              Authenticated MCP Server
            </h1>
            <Badge variant="secondary">v1.0.0</Badge>
          </div>
          <ModeToggle />
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl mx-auto space-y-8">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  Authenticated MCP Server
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    This MCP server is protected by OAuth 2.1 using{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      @cloudflare/workers-oauth-provider
                    </code>
                    . Clients register dynamically, complete the authorization
                    flow, and use a Bearer token to call tools. Inside tool
                    handlers, the auth context is available via{" "}
                    <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                      getMcpAuthContext()
                    </code>
                    . Use the MCP Inspector to test the full OAuth flow.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <WrenchIcon
                size={18}
                weight="bold"
                className="text-kumo-subtle"
              />
              <Text size="base" bold>
                Tools
              </Text>
              <Badge variant="secondary">{TOOLS.length}</Badge>
            </div>
            <div className="space-y-2">
              {TOOLS.map((tool) => (
                <Surface
                  key={tool.name}
                  className="p-4 rounded-xl ring ring-kumo-line"
                >
                  <Text size="sm" bold>
                    {tool.name}
                  </Text>
                  <span className="mt-0.5 block">
                    <Text size="xs" variant="secondary">
                      {tool.description}
                    </Text>
                  </span>
                </Surface>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <GlobeIcon size={18} weight="bold" className="text-kumo-subtle" />
              <Text size="base" bold>
                Endpoints
              </Text>
            </div>
            <div className="space-y-2">
              {ENDPOINTS.map((ep) => (
                <Surface
                  key={ep.path}
                  className="p-3 rounded-xl ring ring-kumo-line flex items-center justify-between"
                >
                  <code className="text-sm font-mono text-kumo-default">
                    {ep.path}
                  </code>
                  <Text size="xs" variant="secondary">
                    {ep.description}
                  </Text>
                </Surface>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <TerminalIcon
                size={18}
                weight="bold"
                className="text-kumo-subtle"
              />
              <Text size="base" bold>
                Testing
              </Text>
            </div>
            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-3">
              <Text size="sm" variant="secondary">
                Connect using the{" "}
                <a
                  href="https://github.com/modelcontextprotocol/inspector"
                  className="underline text-kumo-accent"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  MCP Inspector
                </a>
                :
              </Text>
              <pre className="text-sm font-mono bg-kumo-elevated p-3 rounded-lg overflow-x-auto text-kumo-default">
                npx @modelcontextprotocol/inspector
              </pre>
              <Text size="xs" variant="secondary">
                Set the transport to <strong>Streamable HTTP</strong> and URL to{" "}
                <code className="text-xs px-1 py-0.5 rounded bg-kumo-elevated font-mono">
                  http://localhost:5173/mcp
                </code>
                . The inspector will handle the OAuth flow automatically.
              </Text>
            </Surface>
          </section>
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
