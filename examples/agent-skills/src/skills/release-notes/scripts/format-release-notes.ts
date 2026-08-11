import { readFile } from "node:fs/promises";

export default async function run(input: unknown) {
  const styleGuide = (await readFile("references/style-guide.md", "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

  const changes =
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as { changes?: unknown }).changes)
      ? (input as { changes: unknown[] }).changes
      : [];

  const bullets = changes
    .map((change) => String(change).trim())
    .filter(Boolean)
    .map((change) => `- ${change}`);

  return [
    "## Summary",
    "",
    ...(bullets.length ? bullets : ["- Describe the user-facing change."]),
    "",
    "## Notes",
    "",
    "- Generated from the release-notes skill script.",
    ...styleGuide.map((rule) => `- Style guide: ${rule}`)
  ].join("\n");
}
