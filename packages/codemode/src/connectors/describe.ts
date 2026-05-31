/**
 * Connector and skill docs rendering — derives TypeScript documentation from
 * connector descriptors on demand. Also renders skill descriptions.
 */
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "../json-schema-types";
import { sanitizeToolName } from "../utils";
import type { ConnectorDescription, DescribeOutput } from "./types";
import type { CodemodeSkill } from "../skills";

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
  skills?: CodemodeSkill[]
): DescribeOutput {
  // Check skills first
  if (skills) {
    const skill = skills.find((s) => s.name === target);
    if (skill) {
      const parts = [skill.description];
      if (skill.instructions) parts.push(skill.instructions);
      parts.push(`\`\`\`ts\n${skill.code}\n\`\`\``);
      return {
        path: skill.name,
        description: skill.description,
        types: parts.join("\n\n"),
        kind: "skill"
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
