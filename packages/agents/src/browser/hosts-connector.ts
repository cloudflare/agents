/**
 * The `hosts` connector: lets the model see the browser's internal hostnames
 * and point the assignable ones somewhere, next to `cdp` in `browserTool`.
 * Internal — not an entry point.
 */
import {
  CodemodeConnector,
  type ConnectorTool,
  type ConnectorTools
} from "@cloudflare/codemode";
import type { BrowserInternalHosts } from "./browser";
import { validateConnectorArgs } from "./connector-validation";
import type { InternalHostInfo } from "./internal-hosts";

/** How one host reads in the tool description. */
function describeHost(info: InternalHostInfo): string {
  const description = info.description ? ` — ${info.description}` : "";
  const target = info.assignable
    ? `. Assignable; target schema: ${JSON.stringify(info.targetSchema ?? {})}`
    : "";
  return `- ${info.url}${description}${target}`;
}

/**
 * The `## hosts` section of the browser tool's description, or `undefined`
 * when the browser has no internal hostnames.
 */
export function internalHostsDescription(
  hosts: BrowserInternalHosts | undefined
): string | undefined {
  if (!hosts) return undefined;
  const infos = hosts.describe();
  if (infos.length === 0) return undefined;
  const lines = [
    "## hosts",
    "",
    "The browser can open these internal sites, served by your agent rather than the internet. Plain http only: no https:// and no WebSockets, so a dev server's hot reload won't connect; reload the page instead.",
    "",
    ...infos.map(describeHost),
    "",
    "- `hosts.list()` returns each host and the target it points at."
  ];
  if (infos.some((info) => info.assignable)) {
    lines.push(
      "- `hosts.assign({ host, target })` points an assignable host at a target matching its schema and returns `{ url }`; then navigate to the url. It stays assigned across runs until you assign or clear it again.",
      "- `hosts.clear({ host })` unassigns a host. An unassigned host answers 502."
    );
  }
  return lines.join("\n");
}

export class InternalHostsConnector extends CodemodeConnector {
  readonly #hosts: BrowserInternalHosts;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    hosts: BrowserInternalHosts
  ) {
    super(ctx, {});
    this.#hosts = hosts;
  }

  name(): string {
    return "hosts";
  }

  protected override tool(name: string, tool: ConnectorTool): ConnectorTool {
    return validateConnectorArgs(this.name(), name, tool);
  }

  protected tools(): ConnectorTools {
    return {
      list: {
        description:
          "List the internal hostnames: url, description, whether it's assignable, its target schema, and its current target.",
        inputSchema: { type: "object", properties: {} },
        execute: () => this.#hosts.list()
      },
      assign: {
        description:
          "Point an assignable internal hostname at a target matching its schema. Returns { url }.",
        inputSchema: {
          type: "object",
          properties: {
            host: {
              type: "string",
              description: 'The hostname, e.g. "preview.internal"'
            },
            target: { description: "A value matching the host's target schema" }
          },
          required: ["host", "target"]
        },
        execute: (args) => {
          const { host, target } = args as { host: string; target: unknown };
          return this.#hosts.assign(host, target);
        }
      },
      clear: {
        description:
          "Unassign an internal hostname. Returns whether it had a target.",
        inputSchema: {
          type: "object",
          properties: { host: { type: "string" } },
          required: ["host"]
        },
        execute: async (args) => {
          const { host } = args as { host: string };
          return { cleared: await this.#hosts.clear(host) };
        }
      }
    };
  }
}
