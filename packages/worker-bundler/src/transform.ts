/**
 * Narrow transform-only entrypoint.
 *
 * `@cloudflare/worker-bundler/transform` exposes exactly the Sucrase-backed
 * source transformation without the resolver, installer, or bundler paths, so
 * consumers such as `@cloudflare/run` can strip TypeScript without pulling
 * the rest of the bundler into their output.
 */
import { transform } from "sucrase";
import { isJsxFile, isTypeScriptFile } from "./source-file-kinds";

/** Output of one `transformCode()` call. */
export interface TransformResult {
  code: string;
  sourceMap?: string;
}

/** Options accepted by `transformCode()`. */
export interface TransformOptions {
  /**
   * Source file path. Its extension selects the transforms: `.ts`/`.mts`
   * strip TypeScript, `.jsx`/`.tsx` additionally transform JSX. The path also
   * labels source maps and error messages.
   */
  filePath: string;

  /**
   * Whether to generate source maps
   */
  sourceMap?: boolean;

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
