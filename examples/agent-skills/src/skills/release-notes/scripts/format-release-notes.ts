export default async function run(input: unknown) {
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
    "- Generated from the release-notes skill script."
  ].join("\n");
}
