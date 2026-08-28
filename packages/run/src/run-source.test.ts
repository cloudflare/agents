import { expect, it } from "vitest";
import { run } from "./index";
import { RunError } from "./run-error";
import { rewriteRunStack } from "./run-source";
import { createRecordingLoader } from "./run-test-recording-loader";
import { LOCAL_DYNAMIC_WORKER_LOADER } from "./run-test-worker-loader";

it("executes every guaranteed TypeScript form in one program", async () => {
  const result = await run<{ area: number; label: string }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
interface Shape {
  width: number;
}
type Label = string;
const identity = <Value,>(value: Value): Value => value;
const shape = { width: 3 } satisfies Shape;
const width: number = identity<number>(shape.width);
const label = "square" as Label;
return { area: width ** 2, label };
`
  });

  expect(result.status).toBe("completed");
  expect(result.value).toEqual({ area: 9, label: "square" });
});

it("reports a TypeScript runtime error on the submitted source line", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `const label: string = "start";
interface Unused {
  width: number;
}
throw new Error("typescript line five");`
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.code).toBe("RUN_EXECUTION_ERROR");
  expect(failure.message).toBe("typescript line five");
  expect(failure.stack).toMatch(/run\.js:5:\d+/);
  expect(failure.stack).not.toContain("executor.js");
});

it("reports a JavaScript runtime error on the submitted source line", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `const first = 1;
const second = 2;
throw new Error("javascript line three");`
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.stack).toMatch(/run\.js:3:\d+/);
  expect(failure.stack).not.toContain("executor.js");
});

it("adjusts every run.js frame and keeps useful function names", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `function inner(): never {
  throw new Error("nested failure");
}
function outer(): never {
  return inner();
}
return outer();`
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.stack).toMatch(/at inner \(run\.js:2:\d+\)/);
  expect(failure.stack).toMatch(/at outer \(run\.js:5:\d+\)/);
  expect(failure.stack).toMatch(/run\.js:7:\d+/);
  expect(failure.stack).not.toContain("executor.js");
  expect(failure.stack).not.toContain("data:");
});

it.each([
  ["malformed JavaScript", "return (;"],
  ["malformed TypeScript", "const value: = 1;"],
  ["JSX", "return <div>hello</div>;"],
  [
    "wrapper escape",
    '}\nconsole.log("must not run during module initialization");\nif (true) {'
  ]
])("rejects %s before loading", async (_name, source) => {
  const recording = createRecordingLoader();

  const failure = await run({ loader: recording.loader, source }).catch(
    (cause: unknown) => cause
  );

  expect(failure).toBeInstanceOf(RunError);
  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_COMPILE_ERROR"
  });
  expect(recording.loadedCode).toEqual([]);
});

it.each([
  ["static import", 'import { fixture } from "fixture";\nreturn fixture;'],
  ["import type", 'import type { Fixture } from "fixture";\nreturn 1;'],
  ["literal dynamic import", 'return await import("fixture");'],
  [
    "computed dynamic import",
    'const specifier = "fix" + "ture";\nreturn await import(specifier);'
  ],
  ["import.meta", "return import.meta.url;"]
])("rejects %s before loading", async (_name, source) => {
  const recording = createRecordingLoader();

  const failure = await run({ loader: recording.loader, source }).catch(
    (cause: unknown) => cause
  );

  expect(failure).toBeInstanceOf(RunError);
  expect(failure).toMatchObject({
    name: "RunError",
    code: "RUN_COMPILE_ERROR"
  });
  expect(recording.loadedCode).toEqual([]);
});

it("accepts comments, strings, properties, and identifiers containing import", async () => {
  const result = await run<{ importer: number; note: string }>({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `
// import statements are rejected, but this comment is not one
/* neither is import inside a block comment */
const note = "import { x } from 'y'";
const record = { import: 7, importance: "high" };
const importer = record.import;
return { importer, note };
`
  });

  expect(result.value).toEqual({
    importer: 7,
    note: "import { x } from 'y'"
  });
});

it("keeps compile diagnostics bounded and free of submitted source", async () => {
  const marker = "RUN_SOURCE_PRIVACY_MARKER";
  const failure = await run({
    loader: createRecordingLoader().loader,
    source: `const ${marker} = "${"filler ".repeat(2_000)}";\nreturn (;`
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.code).toBe("RUN_COMPILE_ERROR");
  expect(failure.message).not.toContain(marker);
  expect(failure.message).not.toContain("filler");
  expect(failure.message.length).toBeLessThan(400);
});

it("locates a compile failure on the submitted source line", async () => {
  const failure = await run({
    loader: createRecordingLoader().loader,
    source: "const one = 1;\nconst two = 2;\nreturn (;"
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.code).toBe("RUN_COMPILE_ERROR");
  expect(failure.message).toMatch(
    /^Run source could not be compiled \(run\.js:3:\d+\)\.$/
  );
});

it("keeps regex-derived compile diagnostics free of submitted source", async () => {
  const failure = await run({
    loader: createRecordingLoader().loader,
    source: "const pattern = /RUN_SOURCE_PRIVACY_MARKER[/;\nreturn 1;"
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.code).toBe("RUN_COMPILE_ERROR");
  // Exactly the fixed prose plus the adjusted location may appear.
  expect(failure.message).toMatch(
    /^Run source could not be compiled \(run\.js:1:\d+\)\.$/
  );
  expect(failure.message).not.toContain("RUN_SOURCE_PRIVACY_MARKER");
  expect(failure.cause).toBeUndefined();
});

it("rewrites frames whose function display names contain parentheses", async () => {
  const failure = await run({
    loader: LOCAL_DYNAMIC_WORKER_LOADER,
    source: `const helper = {
  "foo(bar)"() {
    throw new Error("paren name");
  }
};
helper["foo(bar)"]();`
  }).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(RunError);
  if (!(failure instanceof RunError)) throw failure;
  expect(failure.stack).toMatch(/foo\(bar\).*\(run\.js:3:\d+\)/);
  expect(failure.stack).toMatch(/run\.js:6:\d+/);
  expect(failure.stack).not.toContain("executor.js");
});

it("drops frame look-alikes while rewriting genuine run.js frames", () => {
  const stack = [
    "Error: crafted",
    "    at inner (run.js:4:9)",
    "    at run.js:6:2",
    "    at fake (data:text/javascript,run.js:4:9)",
    "    at not-run.js:4:9",
    "    at evil (not-run.js:4:9)",
    "    at wrapper (run.js:1:40)",
    "    at default.evaluate (executor.js:6:41)"
  ].join("\n");

  expect(rewriteRunStack(stack)).toBe(
    ["Error: crafted", "    at inner (run.js:3:9)", "    at run.js:5:2"].join(
      "\n"
    )
  );
});
