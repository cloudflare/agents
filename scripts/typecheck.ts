import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import os from "node:os";

const execAsync = promisify(exec);

const tsconfigs: string[] = [];

for await (const file of await fg.glob("**/tsconfig.json")) {
  if (file.includes("node_modules")) continue;
  tsconfigs.push(file);
}

const concurrency = Math.max(os.cpus().length, 2);
console.log(
  `Typechecking ${tsconfigs.length} projects (${concurrency} concurrent)...`
);

type Result = {
  tsconfig: string;
  success: boolean;
  output: string;
};

async function checkProject(tsconfig: string): Promise<Result> {
  try {
    await execAsync(`tsc -p ${tsconfig}`);
    return { tsconfig, success: true, output: "" };
  } catch (rawError: unknown) {
    const error = rawError as { stdout?: string; stderr?: string };
    const output = error.stdout || error.stderr || "";
    return { tsconfig, success: false, output };
  }
}

// Run with concurrency limit
const results: Result[] = [];
const queue = [...tsconfigs];
const active: Promise<void>[] = [];

async function runNext(): Promise<void> {
  while (queue.length > 0) {
    const tsconfig = queue.shift()!;
    const result = await checkProject(tsconfig);
    results.push(result);
    if (result.success) {
      console.log(`  ✅ ${result.tsconfig}`);
    } else {
      console.error(`  ❌ ${result.tsconfig}`);
    }
  }
}

for (let i = 0; i < concurrency; i++) {
  active.push(runNext());
}

await Promise.all(active);

const failed = results.filter((r) => !r.success);

if (failed.length > 0) {
  console.error(
    `\n${failed.length} of ${tsconfigs.length} projects failed to typecheck:\n`
  );
  for (const f of failed) {
    console.error(`--- ${f.tsconfig} ---`);
    console.error(f.output);
    console.error("");
  }
  process.exit(1);
}

console.log(`\nAll ${tsconfigs.length} projects typecheck successfully!`);
