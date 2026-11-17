import type {
  Client,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  Prompt,
  Resource,
  ResourceTemplateType as ResourceTemplate,
  Tool
} from "@modelcontextprotocol/client";
import type { MCPClientConnection } from "./connection";
import type { MCPServerRow } from "./storage";
import type { MCPServerFilter } from "./types";

type CapabilityErrorHandler = <T>(
  empty: T,
  method: string
) => (error: { code: number }) => T;

type CatalogFetchOptions = {
  probing: boolean;
  onCapabilityError: CapabilityErrorHandler;
};

export async function fetchMcpTools(
  client: Client,
  options: CatalogFetchOptions
): Promise<Tool[]> {
  let aggregate: Tool[] = [];
  let page: ListToolsResult = { tools: [] };
  do {
    const params = { cursor: page.nextCursor };
    page = await (
      options.probing
        ? client.request({ method: "tools/list", params })
        : client.listTools(params)
    ).catch(options.onCapabilityError({ tools: [] }, "tools/list"));
    aggregate = aggregate.concat(page.tools);
  } while (page.nextCursor);
  return aggregate;
}

export async function fetchMcpResources(
  client: Client,
  options: CatalogFetchOptions
): Promise<Resource[]> {
  let aggregate: Resource[] = [];
  let page: ListResourcesResult = { resources: [] };
  do {
    const params = { cursor: page.nextCursor };
    page = await (
      options.probing
        ? client.request({ method: "resources/list", params })
        : client.listResources(params)
    ).catch(options.onCapabilityError({ resources: [] }, "resources/list"));
    aggregate = aggregate.concat(page.resources);
  } while (page.nextCursor);
  return aggregate;
}

export async function fetchMcpPrompts(
  client: Client,
  options: CatalogFetchOptions
): Promise<Prompt[]> {
  let aggregate: Prompt[] = [];
  let page: ListPromptsResult = { prompts: [] };
  do {
    const params = { cursor: page.nextCursor };
    page = await (
      options.probing
        ? client.request({ method: "prompts/list", params })
        : client.listPrompts(params)
    ).catch(options.onCapabilityError({ prompts: [] }, "prompts/list"));
    aggregate = aggregate.concat(page.prompts);
  } while (page.nextCursor);
  return aggregate;
}

export async function fetchMcpResourceTemplates(
  client: Client,
  options: CatalogFetchOptions
): Promise<ResourceTemplate[]> {
  let aggregate: ResourceTemplate[] = [];
  let page: ListResourceTemplatesResult = { resourceTemplates: [] };
  do {
    const params = { cursor: page.nextCursor };
    page = await (
      options.probing
        ? client.request({ method: "resources/templates/list", params })
        : client.listResourceTemplates(params)
    ).catch(
      options.onCapabilityError(
        { resourceTemplates: [] },
        "resources/templates/list"
      )
    );
    aggregate = aggregate.concat(page.resourceTemplates);
  } while (page.nextCursor);
  return aggregate;
}

export type NamespacedData = {
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
  resourceTemplates: (ResourceTemplate & { serverId: string })[];
};

/** One catalog of every given connection, each entry tagged with its server. */
export function getNamespacedData<T extends keyof NamespacedData>(
  mcpClients: Record<string, MCPClientConnection>,
  type: T
): NamespacedData[T] {
  const namespaced = Object.entries(mcpClients).flatMap(([serverId, conn]) =>
    conn[type].map((item) => ({ ...item, serverId }))
  );
  // TypeScript cannot narrow the union of item types per key here.
  return namespaced as NamespacedData[T];
}

/** The connections a filter selects; every criterion must match. */
export function filterConnections(
  connections: Record<string, MCPClientConnection>,
  servers: () => MCPServerRow[],
  filter: MCPServerFilter | undefined
): Record<string, MCPClientConnection> {
  if (!filter) return connections;
  const serverIds = asList(filter.serverId);
  const serverNames = asList(filter.serverName);
  const states = asList(filter.state);
  const namedIds = serverNames
    ? new Set(
        servers()
          .filter((server) => serverNames.includes(server.name))
          .map((server) => server.id)
      )
    : undefined;
  return Object.fromEntries(
    Object.entries(connections).filter(
      ([id, conn]) =>
        (!serverIds || serverIds.includes(id)) &&
        (!namedIds || namedIds.has(id)) &&
        (!states || states.includes(conn.connectionState))
    )
  );
}

function asList<T>(value: T | T[] | undefined): T[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}
