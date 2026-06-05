import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import os from "node:os";

const execAsync = promisify(exec);
const maxRetries = 3;

const filter = process.argv[2];

const tsconfigs: string[] = [];

for await (const file of await fg.glob("**/tsconfig.json", {
  followSymbolicLinks: false,
  ignore: ["**/node_modules/**"]
})) {
  if (filter && !file.includes(filter)) continue;
  tsconfigs.push(file);
}

const concurrency = Math.max(os.cpus().length, 2);
console.log(
  `Typechecking ${tsconfigs.length} projects (${concurrency} concurrent)...`
);

type Result = {
  tsconfig: string;
  success: boolean;
  attempts: number;
  output: string;
};

async function checkProject(tsconfig: string): Promise<Result> {
  let output = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      await execAsync(`tsgo -p ${tsconfig}`);
      return { tsconfig, success: true, attempts: attempt, output: "" };
    } catch (rawError: unknown) {
      const error = rawError as { stdout?: string; stderr?: string };
      output = error.stdout || error.stderr || "";

      if (attempt <= maxRetries) {
        console.warn(
          `  ⚠️  ${tsconfig} failed attempt ${attempt}; retrying (${attempt}/${maxRetries})...`
        );
      }
    }
  }

  return { tsconfig, success: false, attempts: maxRetries + 1, output };
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
      const retrySuffix =
        result.attempts > 1 ? ` after ${result.attempts} attempts` : "";
      console.log(`  ✅ ${result.tsconfig}${retrySuffix}`);
    } else {
      console.error(
        `  ❌ ${result.tsconfig} after ${result.attempts} attempts`
      );
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
