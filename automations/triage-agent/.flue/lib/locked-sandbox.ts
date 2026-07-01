import { createSandboxSessionEnv } from "@flue/runtime";
import type { SandboxApi, SandboxFactory, SessionEnv } from "@flue/runtime";

/**
 * A sandbox that grants the model NO shell and NO filesystem tools.
 *
 * The triage agent runs on untrusted input (any issue body from anyone), so
 * prompt-injection is a real threat. It has no need for bash or file editing —
 * it only reads an issue and applies existing labels via typed tools. Removing
 * the default workspace tool list shrinks the attack surface: there is no
 * `bash` for an injected instruction to run `env` / `gh auth token`, and no
 * `edit`/`write` to tamper with the checkout.
 *
 * `tools: () => []` replaces the framework's default model-facing tool list
 * (filesystem + shell) with an empty list. The `SandboxApi` methods below are
 * never reachable by the model as a result; they only exist to satisfy the
 * interface and throw if anything unexpectedly calls them.
 */
class NoShellSandboxApi implements SandboxApi {
  private deny(op: string): never {
    throw new Error(`triage-agent sandbox: ${op} is disabled`);
  }

  readFile(): Promise<string> {
    return this.deny("readFile");
  }
  readFileBuffer(): Promise<Uint8Array> {
    return this.deny("readFileBuffer");
  }
  writeFile(): Promise<void> {
    return this.deny("writeFile");
  }
  stat(): Promise<never> {
    return this.deny("stat");
  }
  readdir(): Promise<string[]> {
    return this.deny("readdir");
  }
  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  mkdir(): Promise<void> {
    return this.deny("mkdir");
  }
  rm(): Promise<void> {
    return this.deny("rm");
  }
  exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.deny("exec");
  }
}

export function noShellSandbox(): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      return createSandboxSessionEnv(new NoShellSandboxApi(), "/workspace");
    },
    // No filesystem or shell tools are exposed to the model.
    tools: () => []
  };
}
