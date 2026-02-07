// this looks for all package.jsons in /packages/**/package.json
// and replaces it with the actual version ids

import * as fs from "node:fs";
import fg from "fast-glob";

// we do this in 2 passes
// first let's cycle through all packages and get thier version numbers

/**
 * Minimal interface for the subset of package.json fields this script reads
 * and writes. The index signature allows dynamic access to dependency fields
 * while the explicit properties give type-safe access to name/version.
 */
interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const packageJsons: Record<string, { file: string; packageJson: PackageJson }> =
  {};

for await (const file of await fg.glob(
  "./(packages|examples|guides)/*/package.json"
)) {
  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
  } catch (err) {
    console.error(`Failed to parse ${file}:`, err);
    continue;
  }
  packageJsons[packageJson.name] = {
    file,
    packageJson
  };
}

// then we'll revisit them, and replace any "workspace:*" references
// with "^(actual version)"

for (const [packageName, { file, packageJson }] of Object.entries(
  packageJsons
)) {
  let changed = false;
  const depFields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies"
  ] as const;
  for (const field of depFields) {
    const deps = packageJson[field];
    if (!deps) continue;
    for (const [dependencyName] of Object.entries(deps)) {
      if (dependencyName in packageJsons) {
        let actualVersion = packageJsons[dependencyName].packageJson.version;
        if (!actualVersion.startsWith("0.0.0-")) {
          actualVersion = `^${actualVersion}`;
        }

        console.log(
          `${packageName}: setting ${field}.${dependencyName} to ${actualVersion}`
        );
        deps[dependencyName] = actualVersion;
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}
