import { parse as parseYaml } from "yaml";

export interface ParsedSkillMarkdown {
  data: Record<string, unknown>;
  body: string;
}

export function parseSkillFrontmatter(raw: string): ParsedSkillMarkdown {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };

  const parsed = parseYaml(match[1] ?? "");
  const data =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return { data, body: match[2] ?? "" };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSkillMarkdown(raw: string): {
  name: string;
  description: string;
  body: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
} | null {
  const { data, body } = parseSkillFrontmatter(raw);
  const name = optionalString(data.name);
  const description = optionalString(data.description);

  if (!name || !description) return null;

  return {
    name,
    description,
    body,
    compatibility: optionalString(data.compatibility),
    license: optionalString(data.license),
    allowedTools: optionalString(data["allowed-tools"]),
    metadata: optionalRecord(data.metadata)
  };
}
