import { describe, expect, it } from "vitest";
import {
  OVERSIZED_MODULE_BYTES,
  stubModelsDevSnapshot
} from "./models-dev-snapshot";

const CORE = "/node_modules/@opencode/core/dist/chunks/session-abc.js";

describe("stubModelsDevSnapshot", () => {
  it("replaces the catalog literal with an empty catalog", () => {
    const code =
      "// src/models-dev/snapshot.txt\nvar snapshot_default = '{\"a\":1}';\nexport { snapshot_default };";
    expect(stubModelsDevSnapshot(code, CORE)).toBe(
      "// src/models-dev/snapshot.txt\nvar snapshot_default = '{}';\nexport { snapshot_default };"
    );
  });

  it("leaves other modules alone", () => {
    expect(stubModelsDevSnapshot("export const a = 1;", CORE)).toBeNull();
    expect(
      stubModelsDevSnapshot(
        "// src/models-dev/snapshot.txt\nvar snapshot_default = 'x';",
        "/node_modules/other/index.js"
      )
    ).toBeNull();
  });

  it("throws when the marker is there but the literal changed shape", () => {
    expect(() =>
      stubModelsDevSnapshot(
        "// src/models-dev/snapshot.txt\nconst snapshot = `{}`;",
        CORE
      )
    ).toThrow(/no snapshot literal to replace/);
  });

  it("throws when an oversized module has lost the marker", () => {
    const code = `// src/models-dev/catalog.txt\nvar snapshot_default = '${"x".repeat(OVERSIZED_MODULE_BYTES)}';`;
    expect(() => stubModelsDevSnapshot(code, CORE)).toThrow(
      /has no "\/\/ src\/models-dev\/snapshot\.txt" marker/
    );
  });
});
