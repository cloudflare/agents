import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs";
import type { IFileSystem } from "../../fs/interface";

function withInjectedFsError(
  fs: IFileSystem,
  method: "link" | "symlink",
  message: string
): IFileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === method) {
        return async () => {
          throw new Error(message);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    }
  }) as IFileSystem;
}

describe("ln command error forwarding", () => {
  it("sanitizes symlink error strings before forwarding", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/target.txt": "ok\n" }),
      "symlink",
      "symlink failed at /Users/attacker/private/secret.py via node:internal/modules/cjs/loader:999"
    );
    const env = new Bash({ fs });

    const result = await env.exec("ln -s /target.txt /leak-link");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "ln: symlink failed at <path> via <internal>:999\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("sanitizes hard-link error strings before forwarding", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/target.txt": "ok\n" }),
      "link",
      "link fault near /Users/attacker/workspace at node:internal/process/task_queues:95"
    );
    const env = new Bash({ fs });

    const result = await env.exec("ln /target.txt /hard-link");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ln: link fault near <path> at <internal>:95\n");
    expect(result.exitCode).toBe(1);
  });
});
