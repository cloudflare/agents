import { Link } from "react-router-dom";
import { Text, Surface } from "@cloudflare/kumo";

const features = [
  {
    category: "Core",
    items: [
      {
        name: "State",
        path: "/core/state",
        description: "Real-time state synchronization"
      },
      {
        name: "Callable",
        path: "/core/callable",
        description: "@callable decorator for RPC"
      },
      {
        name: "Streaming",
        path: "/core/streaming",
        description: "Streaming RPC responses"
      },
      {
        name: "Schedule",
        path: "/core/schedule",
        description: "Cron, delayed, and interval tasks"
      },
      {
        name: "Connections",
        path: "/core/connections",
        description: "WebSocket lifecycle and broadcast"
      },
      { name: "SQL", path: "/core/sql", description: "Direct SQL queries" },
      {
        name: "Routing",
        path: "/core/routing",
        description: "Agent naming strategies"
      },
      {
        name: "Retry",
        path: "/core/retry",
        description: "Retry with backoff and shouldRetry"
      }
    ]
  },
  {
    category: "AI",
    items: [
      {
        name: "Chat",
        path: "/ai/chat",
        description: "AI chat with message history"
      },
      {
        name: "Tools",
        path: "/ai/tools",
        description: "Client-side tool execution"
      }
    ]
  },
  {
    category: "MCP",
    items: [
      {
        name: "Server",
        path: "/mcp/server",
        description: "Create MCP tools and resources"
      },
      {
        name: "Client",
        path: "/mcp/client",
        description: "Connect to MCP servers"
      },
      {
        name: "OAuth",
        path: "/mcp/oauth",
        description: "OAuth authentication flow"
      }
    ]
  },
  {
    category: "Workflows",
    items: [
      {
        name: "Basic",
        path: "/workflow/basic",
        description: "Durable multi-step execution"
      },
      {
        name: "Approval",
        path: "/workflow/approval",
        description: "Human-in-the-loop patterns"
      }
    ]
  },
  {
    category: "Multi-Agent",
    items: [
      {
        name: "Supervisor",
        path: "/multi-agent/supervisor",
        description: "Manager-child agent pattern"
      },
      {
        name: "Chat Rooms",
        path: "/multi-agent/rooms",
        description: "Lobby with room agents"
      },
      {
        name: "Workers",
        path: "/multi-agent/workers",
        description: "Fan-out parallel processing"
      },
      {
        name: "Pipeline",
        path: "/multi-agent/pipeline",
        description: "Chain of responsibility"
      }
    ]
  },
  {
    category: "Email",
    items: [
      {
        name: "Receive",
        path: "/email/receive",
        description: "Receive real emails"
      },
      {
        name: "Secure Replies",
        path: "/email/secure",
        description: "HMAC-signed replies"
      }
    ]
  }
];

export function Home() {
  return (
    <div className="h-full flex flex-col">
      <header className="p-6 border-b border-kumo-line">
        <Text variant="heading1">Agents SDK Playground</Text>
        <div className="mt-1">
          <Text variant="secondary" size="sm">
            Interactive demos for every feature of the Cloudflare Agents SDK
          </Text>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl">
          <div className="mb-8">
            <Text variant="secondary">
              Select a feature from the sidebar to explore its capabilities.
              Each demo includes interactive controls, real-time event logging,
              and code examples you can copy.
            </Text>
          </div>

          <div className="space-y-8">
            {features.map((section) => (
              <div key={section.category}>
                <div className="uppercase tracking-wider mb-3">
                  <Text variant="secondary" size="xs" bold>
                    {section.category}
                  </Text>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {section.items.map((item) => (
                    <Link key={item.path} to={item.path} className="block">
                      <Surface className="p-4 rounded-lg ring ring-kumo-line hover:ring-kumo-interact transition-colors">
                        <Text bold>{item.name}</Text>
                        <div className="mt-1">
                          <Text variant="secondary" size="xs">
                            {item.description}
                          </Text>
                        </div>
                      </Surface>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
