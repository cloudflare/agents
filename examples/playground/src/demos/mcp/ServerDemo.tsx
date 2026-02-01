import { DemoWrapper } from "../../layout";

export function McpServerDemo() {
  return (
    <DemoWrapper
      title="MCP Server"
      description="Create MCP (Model Context Protocol) servers with tools, resources, and prompts."
    >
      <div className="max-w-3xl space-y-6">
        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">What is MCP?</h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            The Model Context Protocol (MCP) is an open standard for connecting
            AI assistants to external data sources and tools. Your agent can
            become an MCP server, allowing any MCP-compatible AI (like Claude,
            Cursor, or custom apps) to use its capabilities.
          </p>

          <div className="grid grid-cols-3 gap-4 mt-6">
            <div className="text-center p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <div className="text-2xl mb-2">🔧</div>
              <h4 className="font-medium">Tools</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Functions the AI can call
              </p>
            </div>
            <div className="text-center p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <div className="text-2xl mb-2">📄</div>
              <h4 className="font-medium">Resources</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Data the AI can read
              </p>
            </div>
            <div className="text-center p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <div className="text-2xl mb-2">💬</div>
              <h4 className="font-medium">Prompts</h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                Pre-built prompt templates
              </p>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">How It Works</h3>
          <ol className="space-y-3 text-sm text-neutral-600 dark:text-neutral-400">
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-black dark:bg-white text-white dark:text-black flex items-center justify-center text-xs flex-shrink-0">
                1
              </span>
              <span>
                Extend{" "}
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  McpAgent
                </code>{" "}
                instead of{" "}
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  Agent
                </code>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-black dark:bg-white text-white dark:text-black flex items-center justify-center text-xs flex-shrink-0">
                2
              </span>
              <span>
                Create an{" "}
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  McpServer
                </code>{" "}
                instance with name and version
              </span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-black dark:bg-white text-white dark:text-black flex items-center justify-center text-xs flex-shrink-0">
                3
              </span>
              <span>
                Register tools, resources, and prompts in the{" "}
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  init()
                </code>{" "}
                method
              </span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-black dark:bg-white text-white dark:text-black flex items-center justify-center text-xs flex-shrink-0">
                4
              </span>
              <span>Deploy - the agent automatically handles MCP protocol</span>
            </li>
          </ol>
        </div>

        <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <strong>See also:</strong> The MCP Client demo shows how to connect
            your agent to external MCP servers.
          </p>
        </div>
      </div>
    </DemoWrapper>
  );
}
