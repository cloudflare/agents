// this looks for all package.jsons in /packages/**/package.json
// and replaces it with the actual version ids

import * as fs from "node:fs";
import fg from "fast-glob";

// we do this in 2 passes
// first let's cycle through all packages and get thier version numbers

// biome-ignore lint/suspicious/noExplicitAny: vibes
const packageJsons: Record<string, any> = {};

for await (const file of await fg.glob(
  "./(packages|examples|guides)/*/package.json"
)) {
  const packageJson = JSON.parse(fs.readFileSync(file, "utf8"));
  packageJsons[packageJson.name] = {
    file,
    packageJson,
  };
}

// then we'll revisit them, and replace any "workspace:*" references
// with "^(actual version)"

for (const [packageName, { file, packageJson }] of Object.entries(
  packageJsons
)) {
  let changed = false;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [dependencyName, dependencyVersion] of Object.entries(
      packageJson[field] || {}
    )) {
      if (dependencyName in packageJsons) {
        let actualVersion = packageJsons[dependencyName].packageJson.version;
        if (!actualVersion.startsWith("0.0.0-")) {
          actualVersion = `^${actualVersion}`;
        }

        console.log(
          `${packageName}: setting ${field}.${dependencyName} to ${actualVersion}`
        );
        packageJson[field][dependencyName] = actualVersion;
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}
