import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import fg from "fast-glob";

/**
 * Recursively extract all file paths from an exports object
 */
function extractFilePaths(
  exports: unknown,
  paths: Set<string> = new Set()
): Set<string> {
  if (typeof exports === "string") {
    // Simple string path
    paths.add(exports);
  } else if (Array.isArray(exports)) {
    // Array of paths
    for (const item of exports) {
      extractFilePaths(item, paths);
    }
  } else if (exports && typeof exports === "object") {
    // Object with conditions (import, require, types, default, etc.)
    for (const value of Object.values(exports)) {
      extractFilePaths(value, paths);
    }
  }
  return paths;
}

/**
 * Check if all files referenced in a package's exports field exist
 */
function checkPackage(packageJsonPath: string): {
  packageName: string;
  missing: string[];
} {
  const packageDir = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  const packageName = packageJson.name || packageJsonPath;

  const missing: string[] = [];

  if (!packageJson.exports) {
    // No exports field, nothing to check
    return { packageName, missing };
  }

  // Extract all file paths from exports
  const filePaths = extractFilePaths(packageJson.exports);

  // Check if each file exists
  for (const filePath of filePaths) {
    // Skip non-file paths (like package names or special conditions)
    if (!filePath.startsWith(".")) {
      continue;
    }

    const fullPath = resolve(packageDir, filePath);
    if (!existsSync(fullPath)) {
      missing.push(filePath);
    }
  }

  return { packageName, missing };
}

// Main execution
async function main() {
  console.log("Checking package exports...\n");

  // Find all package.json files in packages directory
  const packageJsonFiles: string[] = [];
  const SKIP_PACKAGES = new Set(["@cloudflare/agents-ui"]);

  for await (const file of await fg.glob("packages/*/package.json")) {
    if (file.includes("node_modules")) continue;
    const pkg = JSON.parse(readFileSync(file, "utf-8"));
    if (SKIP_PACKAGES.has(pkg.name)) continue;
    packageJsonFiles.push(file);
  }

  if (packageJsonFiles.length === 0) {
    console.error("No packages found!");
    process.exit(1);
  }

  const results: Array<{ packageName: string; missing: string[] }> = [];

  // Check each package
  for (const packageJsonPath of packageJsonFiles) {
    const result = checkPackage(packageJsonPath);
    results.push(result);

    if (result.missing.length === 0) {
      console.log(`✓ ${result.packageName} - all exports valid`);
    } else {
      console.error(`✗ ${result.packageName} - missing files:`);
      for (const file of result.missing) {
        console.error(`  - ${file}`);
      }
    }
  }

  // Summary
  const failed = results.filter((r) => r.missing.length > 0);

  if (failed.length > 0) {
    console.error(
      `\n${failed.length} of ${results.length} packages have missing export files!`
    );
    process.exit(1);
  }

  console.log(`\nAll ${results.length} packages have valid exports!`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
