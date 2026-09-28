import { jsonSchema, tool } from "ai";
import type { ModelMessage, Tool, ToolSet, UIMessage } from "ai";

/** A deferred tool as the discovery tool describes it to the model. */
export interface DeferredTool {
  name: string;
  description: string;
}

/**
 * Keep some tools' schemas out of model requests until the model asks for
 * them. See {@link Think.toolDiscovery}.
 */
export interface ToolDiscovery {
  /**
   * Which tools start deferred: a list of names, or a predicate over every
   * tool in the turn (application, action, MCP, client, and built-in tools
   * alike). Tools not deferred are sent as usual.
   */
  defer: readonly string[] | ((name: string, tool: ToolSet[string]) => boolean);
  /**
   * Choose deferred tools for the model's query. Only names in `catalog` are
   * honored, so a search cannot surface a tool the turn does not expose.
   * Defaults to exact names in the query, then a keyword match over names
   * and descriptions.
   */
  search?: (
    query: string,
    catalog: readonly DeferredTool[]
  ) => readonly string[] | Promise<readonly string[]>;
  /**
   * Most tools the default search activates for one query. Tools named
   * exactly in the query are always activated and count toward the limit;
   * keyword matches fill what remains. @default 5
   */
  maxResults?: number;
  /**
   * List the deferred tool names in the discovery tool's description, so the
   * model knows what it can ask for. Turn off for catalogs large enough that
   * the list itself is a cost, and rely on `search`. @default true
   */
  listCatalog?: boolean;
}

export const DISCOVER_TOOLS_TOOL_NAME = "discover_tools";

/**
 * Whether `name` is a name a turn may have given its discovery tool. A turn
 * suffixes the name when a tool already holds it, so earlier turns' results
 * can sit under a different name than the current turn's.
 */
function isDiscoverToolName(name: string): boolean {
  return /^discover_tools(?:_\d+)?$/.test(name);
}

/**
 * Marks a result as the discovery tool's, so an application tool that holds
 * one of those names, and returns an `activated` list of its own, is not
 * mistaken for it.
 */
const DISCOVERY_RESULT_KIND = "tool-discovery";

/** Tools a turn exposes that `discovery.defer` selects, in tool-set order. */
export function deferredCatalog(
  tools: ToolSet,
  names: readonly string[],
  discovery: ToolDiscovery
): DeferredTool[] {
  const defer = discovery.defer;
  const isDeferred =
    typeof defer === "function"
      ? defer
      : (name: string) => defer.includes(name);
  return names.flatMap((name) => {
    const entry = tools[name];
    if (!entry || !isDeferred(name, entry)) return [];
    const description =
      typeof entry.description === "string" ? entry.description : "";
    return [{ name, description }];
  });
}

function words(text: string, minLength: number): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= minLength);
}

/**
 * Exact tool names in the query first, then tools ranked by how many query
 * words appear in their name (weighted) and description.
 */
export function searchDeferredTools(
  query: string,
  catalog: readonly DeferredTool[],
  maxResults = 5
): string[] {
  const tokens = query.toLowerCase().split(/[\s,]+/);
  const names = new Map(
    catalog.map((entry) => [entry.name.toLowerCase(), entry.name])
  );
  const exact = [...new Set(tokens.flatMap((token) => names.get(token) ?? []))];
  // A token that named a tool is spent; scoring its parts again would pad
  // the result with every tool sharing a prefix.
  const rest = tokens.filter((token) => !names.has(token)).join(" ");
  // A two-letter word only matches a leading name component (`db` in
  // `db_read`); anywhere else, filler like "to" would match `navigate_to_page`.
  const queryWords = new Set(words(rest, 2));
  const ranked = catalog
    .filter((entry) => !exact.includes(entry.name))
    .map((entry) => {
      const nameWords = new Set(words(entry.name, 3));
      const [prefix] = words(entry.name, 1);
      if (prefix?.length === 2) nameWords.add(prefix);
      const descriptionWords = new Set(words(entry.description, 3));
      let score = 0;
      for (const word of queryWords) {
        if (nameWords.has(word)) score += 3;
        else if (descriptionWords.has(word)) score += 1;
      }
      return { name: entry.name, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxResults - exact.length))
    .map((entry) => entry.name);
  return [...exact, ...ranked];
}

export function createDiscoverTool(
  catalog: readonly DeferredTool[],
  discovery: ToolDiscovery
): Tool {
  const listing =
    discovery.listCatalog === false
      ? ""
      : `\n\nNot loaded yet: ${catalog.map((entry) => entry.name).join(", ")}`;
  return tool({
    description:
      "Load tools that are available but not loaded yet. Describe the " +
      "capability you need in a few keywords, or give exact tool names. " +
      "Matching tools become callable on your next step." +
      listing,
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords for the capability, or exact tool names"
        }
      },
      required: ["query"]
    }),
    execute: async ({ query }) => {
      const names = discovery.search
        ? await discovery.search(query, catalog)
        : searchDeferredTools(query, catalog, discovery.maxResults);
      const found = new Set(names);
      // Names only: each tool's description arrives with its schema, and a
      // short result stays whole when older tool outputs are truncated.
      const activated = catalog
        .filter((entry) => found.has(entry.name))
        .map((entry) => entry.name);
      return activated.length > 0
        ? { kind: DISCOVERY_RESULT_KIND, activated }
        : {
            kind: DISCOVERY_RESULT_KIND,
            activated,
            note: "No matching tools. Try other keywords."
          };
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The tool a `toolChoice` of `{ type: "tool" }` forces, if any. */
export function forcedToolName(toolChoice: unknown): string | undefined {
  if (!isRecord(toolChoice) || toolChoice.type !== "tool") return undefined;
  return typeof toolChoice.toolName === "string"
    ? toolChoice.toolName
    : undefined;
}

function activatedNames(output: unknown): string[] {
  const value =
    isRecord(output) && output.type === "json" ? output.value : output;
  if (
    !isRecord(value) ||
    value.kind !== DISCOVERY_RESULT_KIND ||
    !Array.isArray(value.activated)
  ) {
    return [];
  }
  return value.activated.filter(
    (name): name is string => typeof name === "string"
  );
}

type ToolUse = { toolName: string; output?: unknown };

function modelToolUses(messages: readonly ModelMessage[]): ToolUse[] {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part): ToolUse[] => {
          if (part.type === "tool-call") return [{ toolName: part.toolName }];
          if (part.type === "tool-result") {
            return [{ toolName: part.toolName, output: part.output }];
          }
          return [];
        })
  );
}

function transcriptToolUses(messages: readonly UIMessage[]): ToolUse[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part): ToolUse[] => {
      const toolName =
        part.type === "dynamic-tool"
          ? part.toolName
          : part.type.startsWith("tool-")
            ? part.type.slice("tool-".length)
            : undefined;
      if (toolName === undefined) return [];
      const output =
        "state" in part && part.state === "output-available"
          ? part.output
          : undefined;
      return [{ toolName, output }];
    })
  );
}

/**
 * Deferred tools the conversation has already brought in: named in a
 * discovery result, or called. Derived from the messages rather than held in
 * memory, so a resumed or recovered turn, an approval continuation, and every
 * later turn see the same set without persisting anything. Pass the stored
 * transcript as well as the step's model messages: the model messages carry
 * the current turn's steps, but older tool outputs in them are truncated.
 */
export function activeDeferredTools(
  sources: {
    transcript?: readonly UIMessage[];
    messages?: readonly ModelMessage[];
  },
  catalog: readonly DeferredTool[]
): Set<string> {
  const deferred = new Set(catalog.map((entry) => entry.name));
  const active = new Set<string>();
  const uses = [
    ...transcriptToolUses(sources.transcript ?? []),
    ...modelToolUses(sources.messages ?? [])
  ];
  for (const { toolName, output } of uses) {
    if (deferred.has(toolName)) active.add(toolName);
    if (!isDiscoverToolName(toolName)) continue;
    for (const name of activatedNames(output)) {
      if (deferred.has(name)) active.add(name);
    }
  }
  return active;
}
