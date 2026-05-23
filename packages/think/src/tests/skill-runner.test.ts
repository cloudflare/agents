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
tool shout '{"text":"hello"}'`
      })
    ).resolves.toEqual({
      stdout: 'input={"text":"hello"}\n"HELLO"\n',
      stderr: "",
      exitCode: 0
    });
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
