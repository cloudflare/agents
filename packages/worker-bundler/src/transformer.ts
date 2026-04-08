import { transform } from "sucrase";
import { parseImports, resolveModule } from "./resolver";
import type { FileSystem } from "./file-system";
import type { CreateWorkerResult, Modules } from "./types";

export interface TransformResult {
  code: string;
  sourceMap?: string;
}

export interface TransformOptions {
  /**
   * Source file path (for source maps and error messages)
   */
  filePath: string;

  /**
   * Whether to generate source maps
   */
  sourceMap?: boolean;

  /**
   * Whether to preserve JSX (don't transform to createElement calls)
   */
  preserveJsx?: boolean;

  /**
   * JSX runtime ('automatic' for new JSX transform, 'classic' for React.createElement)
   */
  jsxRuntime?: "automatic" | "classic" | "preserve";

  /**
   * JSX import source for automatic runtime (default: 'react')
   */
  jsxImportSource?: string;

  /**
   * Whether this is a production build
   */
  production?: boolean;
}

/**
 * Transform TypeScript/JSX code to JavaScript using Sucrase.
 *
 * Sucrase is a super-fast TypeScript transformer that:
 * - Strips type annotations
 * - Transforms JSX
 * - Is ~20x faster than Babel
 * - Works in any JS environment (no WASM needed)
 *
 * @param code - Source code to transform
 * @param options - Transform options
 * @returns Transformed code
 */
export function transformCode(
  code: string,
  options: TransformOptions
): TransformResult {
  const {
    filePath,
    sourceMap = false,
    jsxRuntime = "automatic",
    jsxImportSource = "react",
    production = false
  } = options;

  const transforms: Array<"typescript" | "jsx" | "flow"> = [];

  // Determine transforms based on file extension
  if (isTypeScriptFile(filePath)) {
    transforms.push("typescript");
  }

  if (isJsxFile(filePath)) {
    if (jsxRuntime !== "preserve") {
      transforms.push("jsx");
    }
  }

  if (transforms.length === 0) {
    // No transforms needed, return as-is
    return { code };
  }

  const transformOptions: Parameters<typeof transform>[1] = {
    transforms,
    filePath,
    jsxRuntime,
    jsxImportSource,
    production,
    // Keep ESM imports/exports as-is
    preserveDynamicImport: true,
    // Disable ES transforms since Workers support modern JS
    disableESTransforms: true
  };

  if (sourceMap) {
    transformOptions.sourceMapOptions = {
      compiledFilename: filePath.replace(/\.(tsx?|mts)$/, ".js")
    };
  }

  const result = transform(code, transformOptions);

  if (result.sourceMap) {
    return {
      code: result.code,
      sourceMap: JSON.stringify(result.sourceMap)
    };
  }
  return { code: result.code };
}

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

/**
 * Check if a file path is any JavaScript/TypeScript file
 */
export function isJavaScriptFile(filePath: string): boolean {
  return /\.(js|jsx|ts|tsx|mjs|mts)$/.test(filePath);
}

/**
 * Get the output path for a transformed file
 */
export function getOutputPath(filePath: string): string {
  // .ts -> .js, .tsx -> .js, .mts -> .mjs
  return filePath.replace(/\.tsx?$/, ".js").replace(/\.mts$/, ".mjs");
}

/**
 * Transform all files and resolve their dependencies.
 * This produces multiple modules instead of a single bundle.
 */
export async function transformAndResolve(
  files: FileSystem,
  entryPoint: string,
  externals: string[]
): Promise<CreateWorkerResult> {
  const modules: Modules = {};
  const warnings: string[] = [];
  const processed = new Set<string>();
  const toProcess = [entryPoint];

  // Map from source path to output path
  const pathMap = new Map<string, string>();

  // First pass: collect all files and their output paths
  while (toProcess.length > 0) {
    const filePath = toProcess.pop();
    if (!filePath || processed.has(filePath)) continue;
    processed.add(filePath);

    const content = files.read(filePath);
    if (content === null) {
      warnings.push(`File not found: ${filePath}`);
      continue;
    }

    // Calculate output path
    const outputPath = isTypeScriptFile(filePath)
      ? getOutputPath(filePath)
      : filePath;
    pathMap.set(filePath, outputPath);

    // Handle non-JS files
    if (!isJavaScriptFile(filePath)) {
      if (filePath.endsWith(".json")) {
        try {
          modules[filePath] = { json: JSON.parse(content) };
        } catch {
          warnings.push(`Failed to parse JSON file: ${filePath}`);
        }
      } else {
        // Include as text
        modules[filePath] = { text: content };
      }
      continue;
    }

    // Parse imports and queue them for processing
    const imports = parseImports(content);
    for (const specifier of imports) {
      // Skip external modules
      if (
        externals.includes(specifier) ||
        externals.some(
          (e) => specifier.startsWith(`${e}/`) || specifier.startsWith(e)
        )
      ) {
        continue;
      }

      try {
        const resolved = resolveModule(specifier, {
          files,
          importer: filePath
        });

        if (!resolved.external && !processed.has(resolved.path)) {
          toProcess.push(resolved.path);
        }
      } catch (error) {
        warnings.push(
          `Failed to resolve '${specifier}' from ${filePath}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
  }

  // Second pass: transform files and rewrite imports
  for (const [sourcePath, outputPath] of pathMap) {
    const content = files.read(sourcePath);
    if (content === null || !isJavaScriptFile(sourcePath)) continue;

    let transformedCode: string;

    if (isTypeScriptFile(sourcePath)) {
      try {
        const result = transformCode(content, {
          filePath: sourcePath
        });
        transformedCode = result.code;
      } catch (error) {
        warnings.push(
          `Failed to transform ${sourcePath}: ${error instanceof Error ? error.message : error}`
        );
        continue;
      }
    } else {
      transformedCode = content;
    }

    // Rewrite imports to use the full output paths
    transformedCode = rewriteImports(
      transformedCode,
      sourcePath,
      files,
      pathMap,
      externals
    );

    // Add to output modules
    modules[outputPath] = transformedCode;
  }

  // Calculate the main module path (transformed entry point)
  const mainModule = isTypeScriptFile(entryPoint)
    ? getOutputPath(entryPoint)
    : entryPoint;

  if (warnings.length > 0) {
    return { mainModule, modules, warnings };
  }
  return { mainModule, modules };
}

/**
 * Rewrite import specifiers to use full output paths.
 * This is necessary because the Worker Loader expects imports to match registered module names.
 */
function rewriteImports(
  code: string,
  importer: string,
  files: FileSystem,
  pathMap: Map<string, string>,
  externals: string[]
): string {
  // Match import/export statements with string specifiers
  // Handles: import x from 'y', import { x } from 'y', import 'y', export { x } from 'y', export * from 'y'
  const importExportRegex =
    /(import\s+(?:[\w*{}\s,]+\s+from\s+)?|export\s+(?:[\w*{}\s,]+\s+)?from\s+)(['"])([^'"]+)\2/g;

  // Get importer's output path to use as the base for resolving
  const importerOutputPath = pathMap.get(importer) ?? importer;

  return code.replace(
    importExportRegex,
    (match, prefix: string, quote: string, specifier: string) => {
      // Skip external modules
      if (
        externals.includes(specifier) ||
        externals.some(
          (e) => specifier.startsWith(`${e}/`) || specifier.startsWith(e)
        )
      ) {
        return match;
      }

      // Skip non-relative imports that aren't in our files (bare imports to npm packages)
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        // Try to resolve it - if it resolves to node_modules, rewrite the path
        try {
          const resolved = resolveModule(specifier, {
            files,
            importer
          });

          if (resolved.external) {
            return match;
          }

          // Get the output path for the resolved module
          const resolvedOutputPath =
            pathMap.get(resolved.path) ?? resolved.path;

          // For node_modules imports, use the full path
          if (resolved.path.startsWith("node_modules/")) {
            return `${prefix}${quote}/${resolvedOutputPath}${quote}`;
          }

          // Calculate relative path for non-node_modules
          const relativePath = calculateRelativePath(
            importerOutputPath,
            resolvedOutputPath
          );
          return `${prefix}${quote}${relativePath}${quote}`;
        } catch {
          // Resolution failed, keep original
          return match;
        }
      }

      try {
        const resolved = resolveModule(specifier, {
          files,
          importer
        });

        if (resolved.external) {
          return match;
        }

        // Get the output path for the resolved module
        const resolvedOutputPath = pathMap.get(resolved.path) ?? resolved.path;

        // Calculate the relative path from the importer's output location to the resolved output
        const relativePath = calculateRelativePath(
          importerOutputPath,
          resolvedOutputPath
        );

        // Return the rewritten import with the relative output path
        return `${prefix}${quote}${relativePath}${quote}`;
      } catch {
        // If resolution fails, keep the original
        return match;
      }
    }
  );
}

/**
 * Calculate relative path from one file to another.
 */
function calculateRelativePath(from: string, to: string): string {
  const fromDir = getDirectory(from);
  const toDir = getDirectory(to);
  const toFile = to.split("/").pop() ?? to;

  if (fromDir === toDir) {
    // Same directory
    return `./${toFile}`;
  }

  const fromParts = fromDir ? fromDir.split("/") : [];
  const toParts = toDir ? toDir.split("/") : [];

  // Find common prefix
  let commonLength = 0;
  while (
    commonLength < fromParts.length &&
    commonLength < toParts.length &&
    fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++;
  }

  // Calculate relative path
  const upCount = fromParts.length - commonLength;
  const downParts = toParts.slice(commonLength);

  let relativePath = "";
  if (upCount === 0) {
    relativePath = "./";
  } else {
    relativePath = "../".repeat(upCount);
  }

  if (downParts.length > 0) {
    relativePath += `${downParts.join("/")}/`;
  }

  return relativePath + toFile;
}

function getDirectory(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) {
    return "";
  }
  return filePath.slice(0, lastSlash);
}
