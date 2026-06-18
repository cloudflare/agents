import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { tool } from "ai";
import { z } from "zod";
import * as skills from "../skills";
import type { SkillWorkspace } from "../skills";

function testWorkspace(files: Record<string, string>): SkillWorkspace {
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
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async readDir() {
      return Object.keys(files).map(info);
    },
    async glob() {
      return Object.keys(files).map(info);
    },
    async stat(path: string) {
      const content = files[path];
      if (content === undefined) return null;
      return info(path);
    }
  };
}

describe("skill script runner", () => {
  it("runs function-style JavaScript scripts with input, context, and tools", async () => {
    const runner = skills.runner({
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
        path: "scripts/format.js",
        input: { text: "hello" },
        source: `export default async function run(input, ctx) {
  const text = await ctx.tools.shout({ text: input.text });
  return { text, skill: ctx.skill.name };
}`
      })
    ).resolves.toEqual({
      text: "HELLO",
      skill: "release-notes"
    });
  });

  it("surfaces script failures with console output", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "broken",
          description: "Broken skill.",
          body: "Run broken script."
        },
        path: "scripts/broken.js",
        input: {},
        source: `export default async function run() {
  console.log("before failure");
  throw new Error("boom");
}`
      })
    ).rejects.toThrow("before failure");
  });

  it("requires a default-exported function for JS/TS scripts", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "no-default",
          description: "No default export.",
          body: "Run script."
        },
        path: "scripts/run.ts",
        input: {},
        source: `console.log("no default export");`
      })
    ).rejects.toThrow("must `export default`");
  });

  it("rejects an un-precompiled multi-file/TypeScript script with a compile-required error", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    // The runtime ships no in-Worker bundler: a TypeScript / multi-file script
    // that was not compiled ahead of time cannot run and must surface a clear
    // "compile first" error (bundled skills are compiled by the Vite plugin;
    // R2/dynamic skills must be bundled before upload).
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
export default function run(input: { text: string }) {
  return format(input.text);
}`,
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
    ).rejects.toThrow("must be compiled to a self-contained JavaScript module");
  });

  it("runs a precompiled bundled script (esbuild `export { run as default }` form)", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    // Build-time compilation (esbuild) emits the default export as
    // `export { run as default }` and inlines siblings. The runner must
    // normalize this form and run it directly, without any bundler.
    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the script."
        },
        path: "scripts/format.ts",
        input: { text: "hello" },
        source: `function format(text) {
  return text.toUpperCase();
}
async function run(input) {
  return format(input.text);
}
export {
  run as default
};`,
        resources: [
          {
            path: "scripts/format.ts",
            kind: "script",
            encoding: "text",
            precompiled: true,
            content: `function format(text) {
  return text.toUpperCase();
}
async function run(input) {
  return format(input.text);
}
export {
  run as default
};`
          }
        ]
      })
    ).resolves.toBe("HELLO");
  });

  it("runs a precompiled script that also has named exports alongside the default", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    // When a script has named exports too, esbuild groups them with the
    // default: `export { CONSTANT, run as default }`. The runner must still
    // extract the default binding and run it.
    const source = `const CONSTANT = "x";
async function run(input) {
  return input.text.toUpperCase() + CONSTANT.length;
}
export {
  CONSTANT,
  run as default
};`;
    await expect(
      runner.run({
        skill: {
          name: "release-notes",
          description: "Draft release notes.",
          body: "Use the script."
        },
        path: "scripts/format.ts",
        input: { text: "hello" },
        source,
        resources: [
          {
            path: "scripts/format.ts",
            kind: "script",
            encoding: "text",
            precompiled: true,
            content: source
          }
        ]
      })
    ).resolves.toBe("HELLO1");
  });

  it("runs a precompiled script as-is without invoking the in-Worker bundler", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    // The entry resource is marked `precompiled` (as the Agents Vite plugin
    // does at build time): the runner must run `source` directly and never
    // reach for `@cloudflare/worker-bundler`, even though the path is `.ts`
    // (which would otherwise force the runtime bundler).
    await expect(
      runner.run({
        skill: {
          name: "precompiled",
          description: "Precompiled skill.",
          body: "Run the precompiled script."
        },
        path: "scripts/digest.ts",
        input: { text: "hello" },
        source: `export default async function run(input) {
  return input.text.toUpperCase();
}`,
        resources: [
          {
            path: "scripts/digest.ts",
            kind: "script",
            encoding: "text",
            precompiled: true,
            content: `export default async function run(input) {
  return input.text.toUpperCase();
}`
          }
        ]
      })
    ).resolves.toBe("HELLO");
  });

  it("exposes text bundled resources through ctx.files", async () => {
    const runner = skills.runner({
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
        input: {},
        source: `export default function run(input, ctx) {
  return ctx.files["references/template.txt"];
}`,
        resources: [
          {
            path: "references/template.txt",
            kind: "reference",
            encoding: "text",
            content: "template"
          }
        ]
      })
    ).resolves.toBe("template");
  });

  it("returns output artifacts written through ctx.output", async () => {
    const workspace = testWorkspace({});
    const runner = skills.runner({
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
        source: `export default async function run(input, ctx) {
  await ctx.output.writeFile("notes.md", "hello");
  return "ok";
}`
      })
    ).resolves.toEqual({
      result: "ok",
      outputFiles: [
        {
          path: "notes.md",
          encoding: "text",
          content: "hello"
        }
      ]
    });
    // Output artifacts are scratch, not durable workspace writes.
    await expect(workspace.readFile("notes.md")).resolves.toBeNull();
  });

  it("rejects oversized output artifacts", async () => {
    const runner = skills.runner({
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
        source: `export default async function run(input, ctx) {
  await ctx.output.writeFile("large.txt", "x".repeat(64001));
}`
      })
    ).rejects.toThrow("exceeds");
  });

  it("reads workspace files through ctx.workspace by default", async () => {
    const runner = skills.runner({
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
        source: `export default async function run(input, ctx) {
  return await ctx.workspace.readFile("README.md");
}`
      })
    ).resolves.toBe("hello from workspace");
  });

  it("normalizes ctx.workspace.stat to { type, size }", async () => {
    const runner = skills.runner({
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
        path: "scripts/stat.js",
        input: {},
        source: `export default async function run(input, ctx) {
  return await ctx.workspace.stat("README.md");
}`
      })
    ).resolves.toEqual({ type: "file", size: 20 });
  });

  it("requires read-write access for ctx.workspace writes", async () => {
    const readOnlyWorkspace = testWorkspace({});
    const readOnlyRunner = skills.runner({
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
        source: `export default async function run(input, ctx) {
  await ctx.workspace.writeFile("generated.md", "nope");
}`
      })
    ).rejects.toThrow("Workspace write access is not available");

    const writeWorkspace = testWorkspace({});
    const writeRunner = skills.runner({
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
        source: `export default async function run(input, ctx) {
  await ctx.workspace.writeFile("generated.md", "ok");
  return "done";
}`
      })
    ).resolves.toBe("done");
    await expect(writeWorkspace.readFile("generated.md")).resolves.toBe("ok");
  });

  it("denies ctx.workspace access when no workspace is provided", async () => {
    const runner = skills.runner({
      loader: env.LOADER
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
        source: `export default async function run(input, ctx) {
  return await ctx.workspace.readFile("README.md");
}`
      })
    ).rejects.toThrow("Workspace access is not available");
  });

  it("runs bash skill scripts with input files and explicit tools", async () => {
    const runner = skills.runner({
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

  it("mounts binary resources for bash scripts as decoded bytes", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "binary-reader",
          description: "Read binary resources.",
          body: "Use the bash script."
        },
        path: "scripts/read.sh",
        input: {},
        source: "content=$(cat /skill/assets/data.bin)\necho ${#content}",
        resources: [
          {
            path: "assets/data.bin",
            kind: "asset",
            encoding: "base64",
            content: "aGk="
          }
        ]
      })
    ).resolves.toEqual({
      stdout: "2\n",
      stderr: "",
      exitCode: 0
    });
  });

  it("returns non-zero bash exits without throwing", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "failing-bash",
          description: "Fail with output.",
          body: "Use the bash script."
        },
        path: "scripts/fail.sh",
        input: {},
        source: 'echo "before failure"\necho "bad" >&2\nexit 7'
      })
    ).resolves.toEqual({
      stdout: "before failure\n",
      stderr: "bad\n",
      exitCode: 7
    });
  });

  it("rejects unsafe mounted resource paths", async () => {
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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

  it("returns output files from python CLI-style scripts", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "python-writer",
          description: "Write output files.",
          body: "Use the python script."
        },
        path: "scripts/write.py",
        input: {},
        source: `import os

os.makedirs("/output/nested", exist_ok=True)
with open("/output/result.txt", "w") as handle:
    handle.write("hello")
with open("/output/nested/data.bin", "wb") as handle:
    handle.write(bytes([0xff, 0x00, 0x01]))
print("done")`
      })
    ).resolves.toEqual({
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
      outputFiles: [
        {
          path: "/output/nested/data.bin",
          encoding: "base64",
          content: "/wAB"
        },
        {
          path: "/output/result.txt",
          encoding: "text",
          content: "hello"
        }
      ]
    });
  });

  it("returns output files from python function-style scripts", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "python-writer",
          description: "Write output files.",
          body: "Use the python script."
        },
        path: "scripts/write.py",
        input: {},
        source: `def run(input, ctx):
    with open("/output/function.txt", "w") as handle:
        handle.write("function")
    return "ok"`
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

  it("rejects oversized python output artifacts", async () => {
    const runner = skills.runner({
      loader: env.LOADER
    });

    await expect(
      runner.run({
        skill: {
          name: "python-writer",
          description: "Write output files.",
          body: "Use the python script."
        },
        path: "scripts/write.py",
        input: {},
        source: `with open("/output/large.txt", "w") as handle:
    handle.write("x" * 64001)`
      })
    ).rejects.toThrow("Output artifact exceeds");
  });

  it("runs python skill scripts with explicit tools", async () => {
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    const runner = skills.runner({
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
    ).resolves.toMatchObject({
      exitCode: 127
    });

    await expect(workspace.readFile("generated.txt")).resolves.toBeNull();
  });
});
