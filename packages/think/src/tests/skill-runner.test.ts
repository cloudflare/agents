import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { tool } from "ai";
import { z } from "zod";
import { skills } from "../think";
import type { WorkspaceLike } from "../think";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    LOADER: WorkerLoader;
  }
}

function testWorkspace(files: Record<string, string>): WorkspaceLike {
  const info = (path: string) => ({
    name: path,
    path,
    size: files[path].length,
    type: "file" as const,
    mimeType: "text/plain",
    createdAt: 0,
    updatedAt: 0
  });

  return {
    async readFile(path: string) {
      return files[path] ?? null;
    },
    async readFileBytes(path: string) {
      return new TextEncoder().encode(files[path] ?? "");
    },
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async readDir() {
      return Object.keys(files).map(info);
    },
    async rm(path: string) {
      delete files[path];
    },
    async glob() {
      return Object.keys(files).map(info);
    },
    async mkdir() {},
    async stat(path: string) {
      const content = files[path];
      if (content === undefined) return null;
      return info(path);
    }
  };
}

describe("skill script runner", () => {
  it("runs TypeScript skill scripts with input, context, and tools", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      tools: {
        shout: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => text.toUpperCase()
        })
      }
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the script."
        },
        path: "scripts/format.ts",
        input: { text: "hello" },
        source: `export default async function run(
  input: { text: string },
  ctx: { skill: { name: string } }
) {
  const text = await tools.shout({ text: input.text });
  return { text, skill: ctx.skill.name };
}`
      })
    ).resolves.toEqual({
      text: "HELLO",
      skill: "release-notes"
    });
  });

  it("surfaces script failures with console output", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "broken",
          description: "Broken skill.",
          body: "Run broken script."
        },
        path: "scripts/broken.ts",
        input: {},
        source: `export default async function run() {
  console.log("before failure");
  throw new Error("boom");
}`
      })
    ).rejects.toThrow("before failure");
  });

  it("runs TypeScript skill files with sibling script imports", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the script."
        },
        path: "scripts/format.ts",
        input: { text: "hello" },
        source: `import { format } from "./helper";
const data = globalThis.input as { text: string };
console.log(format(data.text));`,
        resources: [
          {
            path: "scripts/helper.ts",
            kind: "script",
            encoding: "text",
            content: `export function format(text: string) {
  return text.toUpperCase();
}`
          }
        ]
      })
    ).resolves.toEqual({
      stdout: "HELLO\n",
      stderr: "",
      exitCode: 0
    });
  });

  it("allows JavaScript skill scripts to read embedded files through fs aliases", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the script."
        },
        path: "scripts/read.js",
        input: { text: "hello" },
        source: `import { readFileSync as read } from "node:fs";
import fs from "fs";
import path from "node:path";
console.log([
  read("/input.json", "utf8"),
  fs.readFileSync(path.join("/skill", "references/template.txt"), "utf8")
].join("\\n"));`,
        resources: [
          {
            path: "references/template.txt",
            kind: "reference",
            encoding: "text",
            content: "template"
          }
        ]
      })
    ).resolves.toEqual({
      stdout: '{"text":"hello"}\ntemplate\n',
      stderr: "",
      exitCode: 0
    });
  });

  it("returns JavaScript output files without mutating workspace", async () => {
    const workspace = testWorkspace({});
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: workspace
    });

    await expect(
      runner.run({
        skill: {
          name: "writer",
          description: "Write output.",
          body: "Use the script."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
writeFileSync("/output/sync.txt", "sync");
await writeFile("/output/async.txt", "async");`
      })
    ).resolves.toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 0,
      outputFiles: [
        {
          path: "/output/sync.txt",
          encoding: "text",
          content: "sync"
        },
        {
          path: "/output/async.txt",
          encoding: "text",
          content: "async"
        }
      ]
    });
    await expect(workspace.readFile("sync.txt")).resolves.toBeNull();
  });

  it("returns output files from function-style JavaScript scripts", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "writer",
          description: "Write output.",
          body: "Use the script."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFileSync } from "node:fs";
export default function run() {
  writeFileSync("/output/function.txt", "function");
  return "ok";
}`
      })
    ).resolves.toEqual({
      result: "ok",
      outputFiles: [
        {
          path: "/output/function.txt",
          encoding: "text",
          content: "function"
        }
      ]
    });
  });

  it("supports dynamic JavaScript imports for fs aliases", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "reader",
          description: "Read files.",
          body: "Use the script."
        },
        path: "scripts/read.js",
        input: {},
        source: `const { readFileSync } = await import("node:fs");
console.log(readFileSync("/skill/references/template.txt", "utf8"));`,
        resources: [
          {
            path: "references/template.txt",
            kind: "reference",
            encoding: "text",
            content: "dynamic"
          }
        ]
      })
    ).resolves.toEqual({
      stdout: "dynamic\n",
      stderr: "",
      exitCode: 0
    });
  });

  it("returns binary JavaScript output files as base64 and rejects oversized artifacts", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "writer",
          description: "Write output.",
          body: "Use the script."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFileSync } from "node:fs";
writeFileSync("/output/data.bin", new Uint8Array([104, 105]));`
      })
    ).resolves.toMatchObject({
      outputFiles: [
        {
          path: "/output/data.bin",
          encoding: "base64",
          content: "aGk="
        }
      ]
    });

    await expect(
      runner.run({
        skill: {
          name: "writer",
          description: "Write output.",
          body: "Use the script."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFileSync } from "node:fs";
writeFileSync("/output/large.txt", "x".repeat(64_001));`
      })
    ).rejects.toThrow("Output artifact exceeds");
  });

  it("keeps JavaScript workspace access async-only", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: testWorkspace({
        "README.md": "hello from workspace"
      })
    });

    await expect(
      runner.run({
        skill: {
          name: "workspace-reader",
          description: "Read workspace files.",
          body: "Use JS."
        },
        path: "scripts/read.js",
        input: {},
        source: `import { readFileSync } from "node:fs";
readFileSync("/workspace/README.md", "utf8");`
      })
    ).rejects.toThrow("Synchronous workspace access is not supported");

    await expect(
      runner.run({
        skill: {
          name: "workspace-reader",
          description: "Read workspace files.",
          body: "Use JS."
        },
        path: "scripts/read.js",
        input: {},
        source: `import { readFile } from "node:fs/promises";
console.log(await readFile("/workspace/README.md", "utf8"));`
      })
    ).resolves.toEqual({
      stdout: "hello from workspace\n",
      stderr: "",
      exitCode: 0
    });

    await expect(
      runner.run({
        skill: {
          name: "workspace-reader",
          description: "Read workspace files.",
          body: "Use JS."
        },
        path: "scripts/read.js",
        input: {},
        source: `import { readdir, stat } from "node:fs/promises";
console.log((await readdir("/workspace")).join(","));
const info = await stat("/workspace/README.md");
console.log([info.isFile(), info.isDirectory(), info.size].join(","));`
      })
    ).resolves.toEqual({
      stdout: "README.md\ntrue,false,20\n",
      stderr: "",
      exitCode: 0
    });
  });

  it("requires read-write access for async JavaScript workspace writes", async () => {
    const readOnlyWorkspace = testWorkspace({});
    const readOnlyRunner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: readOnlyWorkspace
    });

    await expect(
      readOnlyRunner.run({
        skill: {
          name: "workspace-writer",
          description: "Write workspace files.",
          body: "Use JS."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFileSync } from "node:fs";
writeFileSync("/workspace/generated.md", "nope");`
      })
    ).rejects.toThrow("Synchronous workspace writes are not supported");

    await expect(
      readOnlyRunner.run({
        skill: {
          name: "workspace-writer",
          description: "Write workspace files.",
          body: "Use JS."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFile } from "node:fs/promises";
await writeFile("/workspace/generated.md", "nope");`
      })
    ).rejects.toThrow("Workspace write access is not available");

    const writeWorkspace = testWorkspace({});
    const writeRunner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: writeWorkspace,
      workspace: "read-write"
    });

    await expect(
      writeRunner.run({
        skill: {
          name: "workspace-writer",
          description: "Write workspace files.",
          body: "Use JS."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFile } from "node:fs/promises";
await writeFile("/workspace/generated.md", "ok");`
      })
    ).resolves.toMatchObject({
      exitCode: 0
    });
    await expect(writeWorkspace.readFile("generated.md")).resolves.toBe("ok");
  });

  it("rejects relative JavaScript writes outside /output", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "writer",
          description: "Write files.",
          body: "Use JS."
        },
        path: "scripts/write.js",
        input: {},
        source: `import { writeFileSync } from "node:fs";
writeFileSync("generated.md", "nope");`
      })
    ).rejects.toThrow("only write to /output");
  });

  it("runs bash skill scripts with input files and explicit tools", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      tools: {
        shout: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => text.toUpperCase()
        })
      }
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the bash script."
        },
        path: "scripts/format.sh",
        input: { text: "hello" },
        source: `echo "input=$(cat /input.json)"
cat /skill/references/template.txt
tool shout '{"text":"hello"}'`,
        resources: [
          {
            path: "references/template.txt",
            kind: "reference",
            encoding: "text",
            content: "template\n"
          }
        ]
      })
    ).resolves.toEqual({
      stdout: 'input={"text":"hello"}\ntemplate\n"HELLO"\n',
      stderr: "",
      exitCode: 0
    });
  });

  it("rejects unsafe mounted resource paths", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "unsafe",
          description: "Unsafe paths.",
          body: "Use python."
        },
        path: "scripts/read.py",
        input: {},
        source: `print("nope")`,
        resources: [
          {
            path: "../input.json",
            kind: "file",
            encoding: "text",
            content: "{}"
          }
        ]
      })
    ).rejects.toThrow("normalized relative path");
  });

  it("runs python skill scripts with input and context", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the python script."
        },
        path: "scripts/format.py",
        input: { text: "hello" },
        source: `def run(input, ctx):
    return {
        "text": input["text"].upper(),
        "skill": ctx["skill"]["name"]
    }`
      })
    ).resolves.toEqual({
      text: "HELLO",
      skill: "release-notes"
    });
  });

  it("runs python skill files as CLI-style scripts", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the python script."
        },
        path: "scripts/format.py",
        input: { text: "hello" },
        source: `import json

with open("/input.json") as handle:
    data = json.load(handle)

with open("/skill/references/template.txt") as handle:
    template = handle.read()

print(template.replace("{{text}}", data["text"].upper()))`,
        resources: [
          {
            path: "references/template.txt",
            kind: "reference",
            encoding: "text",
            content: "Result: {{text}}"
          }
        ]
      })
    ).resolves.toEqual({
      stdout: "Result: HELLO\n",
      stderr: "",
      exitCode: 0
    });
  });

  it("runs python skill scripts with explicit tools", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      tools: {
        shout: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => text.toUpperCase()
        })
      }
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the python script."
        },
        path: "scripts/format.py",
        input: { text: "hello" },
        source: `async def run(input, ctx):
    text = await tools.shout({"text": input["text"]})
    return {"text": text, "skill": ctx["skill"]["name"]}`
      })
    ).resolves.toEqual({
      text: "HELLO",
      skill: "release-notes"
    });
  });

  it("allows python skill scripts to call tools by dynamic name", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      tools: {
        "format-title": tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => text.toUpperCase()
        })
      }
    });

    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the python script."
        },
        path: "scripts/format.py",
        input: { text: "hello" },
        source: `async def run(input, ctx):
    text = await tools.call("format-title", {"text": input["text"]})
    return {"text": text}`
      })
    ).resolves.toEqual({
      text: "HELLO"
    });
  });

  it("allows python scripts to read from a provided workspace by default", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: testWorkspace({
        "README.md": "hello from workspace"
      })
    });

    await expect(
      runner.run({
        skill: {
          name: "workspace-reader",
          description: "Read workspace files.",
          body: "Use python."
        },
        path: "scripts/read.py",
        input: {},
        source: `async def run(input, ctx):
    return await workspace.read_file("README.md")`
      })
    ).resolves.toBe("hello from workspace");
  });

  it("does not expose python workspace writes for read-only workspace access", async () => {
    const workspace = testWorkspace({});
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: workspace
    });

    await expect(
      runner.run({
        skill: {
          name: "workspace-writer",
          description: "Write workspace files.",
          body: "Use python."
        },
        path: "scripts/write.py",
        input: {},
        source: `async def run(input, ctx):
    await workspace.write_file("generated.txt", "nope")
    return "ok"`
      })
    ).rejects.toThrow("Workspace write access is not available");

    await expect(workspace.readFile("generated.txt")).resolves.toBeNull();
  });

  it("surfaces python script failures", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "broken",
          description: "Broken skill.",
          body: "Run broken script."
        },
        path: "scripts/broken.py",
        input: {},
        source: `def run(input, ctx):
    raise Exception("boom")`
      })
    ).rejects.toThrow("boom");
  });

  it("times out CPU-bound python CLI scripts", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      timeout: 50
    });

    await expect(
      runner.run({
        skill: {
          name: "slow",
          description: "Slow skill.",
          body: "Run slow script."
        },
        path: "scripts/slow.py",
        input: {},
        source: `while True:
    pass`
      })
    ).rejects.toThrow("Python script execution timed out");
  });

  it("allows bash scripts to read from a provided workspace by default", async () => {
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: testWorkspace({
        "README.md": "hello from workspace"
      })
    });

    await expect(
      runner.run({
        skill: {
          name: "workspace-reader",
          description: "Read workspace files.",
          body: "Use bash."
        },
        path: "scripts/read.sh",
        input: {},
        source: "workspace-read README.md"
      })
    ).resolves.toEqual({
      stdout: "hello from workspace",
      stderr: "",
      exitCode: 0
    });
  });

  it("does not expose bash workspace writes for read-only workspace access", async () => {
    const workspace = testWorkspace({});
    const runner = skills.workerScriptRunner({
      loader: env.LOADER,
      workspaceInstance: workspace
    });

    await expect(
      runner.run({
        skill: {
          name: "workspace-writer",
          description: "Write workspace files.",
          body: "Use bash."
        },
        path: "scripts/write.sh",
        input: {},
        source: "echo nope | workspace-write generated.txt"
      })
    ).rejects.toThrow("workspace-write");

    await expect(workspace.readFile("generated.txt")).resolves.toBeNull();
  });
});
