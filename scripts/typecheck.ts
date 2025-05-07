import { type ExecException, execSync } from "node:child_process";
import fg from "fast-glob";

const tsconfigs: string[] = [];

for await (const file of await fg.glob("**/tsconfig.json")) {
  if (file.includes("node_modules")) continue;
  tsconfigs.push(file);
}

console.log(`Typechecking ${tsconfigs.length} projects...`);

type Result = {
  tsconfig: string;
  success: boolean;
  output: string;
};

const results: Result[] = [];

for (const tsconfig of tsconfigs) {
  console.log(`Checking ${tsconfig}...`);
  try {
    const output = execSync(`tsc -p ${tsconfig}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    results.push({ tsconfig, success: true, output });
    console.log(`✅ ${tsconfig} - OK`);
  } catch (rawError: unknown) {
    const error = rawError as ExecException;

    const output =
      error.stdout?.toString() || `${error.stderr?.toString()}` || "";
    results.push({ tsconfig, success: false, output });
    console.error(`❌ ${tsconfig} - Failed:`);
    console.error(output);
  }
}

const failed = results.filter((r) => !r.success);

if (failed.length > 0) {
  console.error(
    `\n${failed.length} of ${tsconfigs.length} projects failed to typecheck!`
  );
  process.exit(1);
}

console.log("All projects typecheck successfully!");
