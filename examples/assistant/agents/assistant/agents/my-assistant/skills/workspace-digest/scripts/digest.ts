import type { SkillRunContext } from "@cloudflare/think";

type FileEntry = { path: string; type?: string; size?: number };

/**
 * Function-style skill script (`export default run(input, ctx)`). Reads the
 * host-provided file list through `ctx.list()` and a bundled formatting hint
 * through `ctx.files`, then returns a compact digest.
 */
export default async function run(input: unknown, ctx: SkillRunContext) {
  const dir =
    typeof input === "object" &&
    input !== null &&
    typeof (input as { dir?: unknown }).dir === "string"
      ? (input as { dir: string }).dir
      : "/";

  const prefix = dir === "/" ? "" : `${dir.replace(/\/$/, "")}/`;
  const entries = ((await ctx.list().catch(() => [])) ?? []) as FileEntry[];
  const files = entries.filter(
    (entry) =>
      (entry.type === undefined || entry.type === "file") &&
      (prefix === "" || entry.path.startsWith(prefix))
  );

  const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const listing = [...files]
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, 25)
    .map((file) => `- ${file.path} (${file.size ?? 0} bytes)`);

  const formatHint = (ctx.files["references/format.md"] ?? "").trim();

  return [
    "# Workspace digest",
    "",
    `${files.length} file(s), ${totalBytes} bytes total under ${dir}.`,
    "",
    ...(listing.length ? listing : ["- (workspace is empty)"]),
    ...(formatHint ? ["", "<!-- formatting hint -->", formatHint] : [])
  ].join("\n");
}
