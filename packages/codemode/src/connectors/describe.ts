/**
 * Connector and snippet docs rendering — derives TypeScript documentation from
 * connector descriptors on demand. Also renders snippet source.
 */
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "../json-schema-types";
import { sanitizeToolName } from "../utils";
import type { ConnectorDescription, DescribeOutput } from "./types";
import type { Snippet } from "../snippet";

function renderConnectorTypes(
  connectorName: string,
  instructions: string | undefined,
  descriptors: JsonSchemaToolDescriptors
): string {
  const types = generateTypesFromJsonSchema(descriptors).replace(
    "declare const codemode",
    `declare const ${sanitizeToolName(connectorName)}`
  );
  return [instructions, types].filter(Boolean).join("\n\n");
}

function renderMethodTypes(
  methodName: string,
  descriptors: JsonSchemaToolDescriptors
): string {
  const descriptor = descriptors[methodName];
  if (!descriptor) return "";
  const generated = generateTypesFromJsonSchema({ [methodName]: descriptor });
  return generated.slice(0, generated.indexOf("declare const codemode")).trim();
}

export function describeTarget(
  target: string,
  descriptions: ConnectorDescription[],
  snippets?: Snippet[]
): DescribeOutput {
  // Check snippets first
  if (snippets) {
    const snippet = snippets.find((s) => s.name === target);
    if (snippet) {
      const parts = [snippet.description];
      parts.push(`\`\`\`ts\n${snippet.code}\n\`\`\``);
      return {
        path: snippet.name,
        description: snippet.description,
        types: parts.join("\n\n"),
        kind: "snippet"
      };
    }
  }

  const [maybeConnector, maybeMethod] = target.includes(".")
    ? target.split(".", 2)
    : [target, undefined];

  const connector = descriptions.find((d) => d.name === maybeConnector);

  // Connector-level describe
  if (connector && !maybeMethod) {
    return {
      path: connector.name,
      description: connector.instructions,
      types: renderConnectorTypes(
        connector.name,
        connector.instructions,
        connector.descriptors
      ),
      kind: "connector"
    };
  }

  // Method-level describe
  const candidates = connector ? [connector] : descriptions;
  const methodName = maybeMethod ?? target;

  for (const candidate of candidates) {
    if (candidate.descriptors[methodName]) {
      return {
        path: `${candidate.name}.${methodName}`,
        description: candidate.descriptors[methodName]?.description,
        types: renderMethodTypes(methodName, candidate.descriptors),
        kind: "method"
      };
    }
  }

  return {
    path: target,
    description: undefined,
    types: `"${target}" not found.`,
    kind: "method"
  };
}
