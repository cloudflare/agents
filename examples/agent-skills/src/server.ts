import { callable, routeAgentRequest } from "agents";
import type { SkillScriptRequest, SkillScriptRunner } from "agents/skills";
import { Workspace } from "@cloudflare/think/workspace";
import type {
  DurableObjectStorageLike,
  WorkspaceRuntimeValue
} from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { Think } from "@cloudflare/think";
import bundledSkills from "agents:skills";

const JAVASCRIPT_BACKEND = "worker-javascript";

export class SkillsAgent extends Think<Env> {
  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerJavaScriptBackend({
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        globalOutbound: null
      })
    ]
  });

  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  getSystemPrompt() {
    return [
      "You are a helpful assistant demonstrating Think Agent Skills.",
      "If a user request matches an available skill, call activate_skill before answering.",
      "Mention which skill you used when it is helpful for the demo."
    ].join("\n");
  }

  getSkills() {
    return [bundledSkills];
  }

  getSkillScriptRunner(): SkillScriptRunner {
    return {
      run: (request) => this.runSkillScript(request)
    };
  }

  private async runSkillScript(request: SkillScriptRequest): Promise<unknown> {
    const runRoot = `/workspace/.skills/${crypto.randomUUID()}`;
    try {
      for (const resource of request.resources ?? []) {
        const path = skillResourcePath(runRoot, resource.path);
        await this.workspace.fs.mkdir(parentPath(path), { recursive: true });
        await this.workspace.fs.writeFile(
          path,
          resource.encoding === "base64"
            ? decodeBase64(resource.content)
            : resource.content
        );
      }

      const scriptPath = skillResourcePath(runRoot, request.path);
      await this.workspace.fs.mkdir(parentPath(scriptPath), {
        recursive: true
      });
      await this.workspace.fs.writeFile(scriptPath, request.source);

      if (!isWorkspaceRuntimeValue(request.input)) {
        throw new Error("Skill script input must be a JSON value");
      }

      const handle = await this.workspace.runtime.exec(
        `export { default } from ${JSON.stringify(`./${request.path}`)};`,
        {
          backend: JAVASCRIPT_BACKEND,
          cwd: runRoot,
          encoding: "utf8",
          input: request.input
        }
      );
      const result = await handle.result();
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || `JavaScript backend exited ${result.exitCode}`
        );
      }
      return result.value;
    } finally {
      await this.workspace.fs.rm(runRoot, { recursive: true, force: true });
    }
  }

  @callable()
  async listSkills() {
    return bundledSkills.list();
  }
}

function skillResourcePath(root: string, relativePath: string): string {
  const parts = relativePath.split("/");
  if (
    relativePath.startsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid skill resource path: ${relativePath}`);
  }
  return `${root}/${parts.join("/")}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function decodeBase64(content: string): Uint8Array {
  return Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
}

function isWorkspaceRuntimeValue(
  value: unknown
): value is WorkspaceRuntimeValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWorkspaceRuntimeValue);
  if (typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isWorkspaceRuntimeValue)
  );
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
