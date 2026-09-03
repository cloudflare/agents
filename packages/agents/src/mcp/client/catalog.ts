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
