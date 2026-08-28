/**
 * Internal file-extension predicates shared by the transform subpath and the
 * multi-file bundling pipeline. Not part of any public export surface.
 */

/**
 * Check if a file path is a TypeScript file
 */
export function isTypeScriptFile(filePath: string): boolean {
  return /\.(ts|tsx|mts)$/.test(filePath);
}

/**
 * Check if a file path is a JSX file
 */
export function isJsxFile(filePath: string): boolean {
  return /\.(jsx|tsx)$/.test(filePath);
}
