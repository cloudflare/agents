import {
  Client,
  type ClientCapabilities,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type ListChangedHandlers,
  type Prompt,
  type Resource,
  type Tool
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import type { McpClientOptions } from "./types";

class CompatibleWorkerJsonSchemaValidator
  extends CfWorkerJsonSchemaValidator
  implements jsonSchemaValidator
{
  private readonly legacy = new CfWorkerJsonSchemaValidator({ draft: "7" });

  override getValidator<T>(schema: JsonSchemaType) {
    const dialect = schema.$schema;
    return typeof dialect === "string" && /draft-0?7/i.test(dialect)
      ? this.legacy.getValidator<T>(schema)
      : super.getValidator<T>(schema);
  }
}

const DEFAULT_CLIENT_OPTIONS: NonNullable<McpClientOptions> = {
  jsonSchemaValidator: new CompatibleWorkerJsonSchemaValidator(),
  versionNegotiation: { mode: "auto" },
  inputRequired: { autoFulfill: true }
};

export function normalizeMcpClientOptions(
  options?: McpClientOptions
): NonNullable<McpClientOptions> {
  return {
    ...DEFAULT_CLIENT_OPTIONS,
    ...options,
    versionNegotiation: {
      ...DEFAULT_CLIENT_OPTIONS.versionNegotiation,
      ...options?.versionNegotiation
    },
    inputRequired: {
      ...DEFAULT_CLIENT_OPTIONS.inputRequired,
      ...options?.inputRequired
    }
  };
}

export function elicitationCapabilitiesFromHandlers(handlers?: {
  form?: unknown;
  url?: unknown;
}): ClientCapabilities["elicitation"] | undefined {
  if (!handlers) return undefined;
  const elicitation: NonNullable<ClientCapabilities["elicitation"]> = {};
  if (handlers.form) elicitation.form = {};
  if (handlers.url) elicitation.url = {};
  return elicitation.form || elicitation.url ? elicitation : undefined;
}

type CatalogCallbacks = {
  tools(error: Error | null, tools: Tool[] | null): void;
  prompts(error: Error | null, prompts: Prompt[] | null): void;
  resources(error: Error | null, resources: Resource[] | null): void;
};

function listChangedHandlers(
  configured: ListChangedHandlers | undefined,
  callbacks: CatalogCallbacks
): ListChangedHandlers {
  return {
    tools: {
      ...configured?.tools,
      onChanged: (error, tools) => {
        callbacks.tools(error, tools);
        configured?.tools?.onChanged(error, tools);
      }
    },
    prompts: {
      ...configured?.prompts,
      onChanged: (error, prompts) => {
        callbacks.prompts(error, prompts);
        configured?.prompts?.onChanged(error, prompts);
      }
    },
    resources: {
      ...configured?.resources,
      onChanged: (error, resources) => {
        callbacks.resources(error, resources);
        configured?.resources?.onChanged(error, resources);
      }
    }
  };
}

export function createMcpSdkClient(
  info: ConstructorParameters<typeof Client>[0],
  options: NonNullable<McpClientOptions>,
  capabilitySeed: ClientCapabilities | undefined,
  handlerModes: { form?: unknown; url?: unknown } | undefined,
  callbacks: CatalogCallbacks
): { client: Client; elicitationEnabled: boolean } {
  const elicitation =
    options.capabilities?.elicitation ??
    elicitationCapabilitiesFromHandlers(handlerModes) ??
    capabilitySeed?.elicitation;
  const client = new Client(info, {
    ...options,
    capabilities: {
      ...capabilitySeed,
      ...options.capabilities,
      ...(elicitation ? { elicitation } : {})
    },
    listChanged: listChangedHandlers(options.listChanged, callbacks)
  });
  return { client, elicitationEnabled: elicitation !== undefined };
}
