import { describe, expect, it } from "vitest";
import { LifecycleCapability } from "../../lifecycle";
import { checkInstanceConformance } from "../shared/instance-conformance";

/**
 * The conformance check itself: it must fail for a named instance that
 * otherwise keeps to its own names but reaches into the default's storage,
 * at startup or by deleting a key.
 */

/** Each instance keeps a marker under its own key; a named one also
 * overwrites the default's at startup. */
class StartupOverwrite extends LifecycleCapability {
  readonly #key: string;
  constructor(name?: string) {
    super("startup-overwrite", name);
    this.#key = this.store.key("marker");
  }
  async onStart(): Promise<void> {
    await this.lifecycle.storage.put(this.#key, "mine");
    if (this.instanceName !== undefined) {
      await this.lifecycle.storage.put("cf_agents:marker", "overwritten");
    }
  }
}

/** Each instance keeps a marker under its own key; a named one deletes
 * the default's in its smoke. */
class DeletesDefaultKey extends LifecycleCapability {
  readonly #key: string;
  constructor(name?: string) {
    super("deletes-default-key", name);
    this.#key = this.store.key("marker");
  }
  async smoke(): Promise<void> {
    await this.lifecycle.storage.put(this.#key, "mine");
    if (this.instanceName !== undefined) {
      await this.lifecycle.storage.delete("cf_agents:marker");
    }
  }
}

describe("instance conformance check", () => {
  it("fails when a named instance overwrites the default's key at startup", async () => {
    await expect(
      checkInstanceConformance({
        kind: "startup-overwrite",
        make: (name) => new StartupOverwrite(name),
        smoke: async () => {}
      })
    ).rejects.toThrow(/after start/);
  });

  it("fails when a named instance deletes the default's key", async () => {
    await expect(
      checkInstanceConformance({
        kind: "deletes-default-key",
        make: (name) => new DeletesDefaultKey(name),
        smoke: (capability) => capability.smoke()
      })
    ).rejects.toThrow(/outside its names/);
  });
});
