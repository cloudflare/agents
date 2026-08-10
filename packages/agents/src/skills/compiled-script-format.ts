/**
 * First line added to generated skill bundles so dynamic sources can identify
 * the build-time compiled script format without relying on JavaScript syntax
 * alone.
 */
export const COMPILED_SKILL_SCRIPT_FORMAT_V1 =
  "// cloudflare-agents:compiled-skill-script:v1";

/**
 * Whether source starts with the V1 compiled skill-script marker. A UTF-8 BOM
 * and CRLF line ending are accepted because publish tooling may normalize them.
 */
export function hasCompiledSkillScriptFormatV1(source: string): boolean {
  const markerStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lineEndingStart = markerStart + COMPILED_SKILL_SCRIPT_FORMAT_V1.length;

  return (
    source.startsWith(COMPILED_SKILL_SCRIPT_FORMAT_V1, markerStart) &&
    (source.startsWith("\n", lineEndingStart) ||
      source.startsWith("\r\n", lineEndingStart))
  );
}
