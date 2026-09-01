import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareImportSizeSnapshots,
  measurePackageImports,
  parseImportSizeSnapshot,
  type ImportSizeMeasurement,
  type ImportSizeSnapshot
} from "../../scripts/import-size-report";

const BUNDLER = {
  name: "esbuild" as const,
  version: "0.28.1"
};

function measurement(
  exportName: string,
  gzipBytes: number,
  bytes = gzipBytes * 3
): ImportSizeMeasurement {
  return {
    entryPoint: "agents",
    exportName,
    bytes,
    gzipBytes
  };
}

function snapshot(
  revision: string,
  measurements: ReadonlyArray<ImportSizeMeasurement>
): ImportSizeSnapshot {
  return {
    schemaVersion: 1,
    kind: "agents-import-size-snapshot",
    packageName: "agents",
    packageVersion: "1.0.0",
    revision,
    bundler: BUNDLER,
    measurements
  };
}

function compare(
  base: ReadonlyArray<ImportSizeMeasurement>,
  head: ReadonlyArray<ImportSizeMeasurement>
) {
  return compareImportSizeSnapshots(
    snapshot("base-sha", base),
    snapshot("head-sha", head),
    {
      repository: "cloudflare/agents",
      pullRequestNumber: 42,
      workflowRunId: 9001,
      workflowRunAttempt: 2,
      thresholdPercent: 10
    }
  );
}

describe("import-size report", () => {
  it("marks an increase at the threshold yellow and passes the gate", () => {
    const report = compare(
      [measurement("Agent", 1_000)],
      [measurement("Agent", 1_100)]
    );

    expect(report.overall).toBe("yellow");
    expect(report.gate).toBe("pass");
    expect(report.summary).toMatchObject({ yellow: 1, red: 0 });
    expect(report.changes[0]?.delta).toMatchObject({
      gzipBytes: 100,
      gzipPercent: 10
    });
  });

  it("marks an increase above the threshold red and fails the gate", () => {
    const report = compare(
      [measurement("Agent", 1_000)],
      [measurement("Agent", 1_101)]
    );

    expect(report.overall).toBe("red");
    expect(report.gate).toBe("fail");
    expect(report.summary).toMatchObject({ red: 1, yellow: 0 });
  });

  it("uses the worst changed import as the overall result", () => {
    const report = compare(
      [
        measurement("Agent", 1_000),
        measurement("callable", 1_000),
        measurement("getAgentByName", 1_000),
        measurement("removed", 1_000)
      ],
      [
        measurement("Agent", 900),
        measurement("callable", 1_001),
        measurement("getAgentByName", 1_000),
        measurement("newExport", 750)
      ]
    );

    expect(report.overall).toBe("yellow");
    expect(report.gate).toBe("pass");
    expect(report.summary).toEqual({
      red: 0,
      yellow: 1,
      green: 1,
      unchanged: 1,
      new: 1,
      removed: 1,
      total: 5
    });
  });

  it("marks decreases and removals green when nothing grew", () => {
    const report = compare(
      [measurement("Agent", 1_000), measurement("removed", 500)],
      [measurement("Agent", 900)]
    );

    expect(report.overall).toBe("green");
    expect(report.gate).toBe("pass");
    expect(report.summary).toMatchObject({ green: 1, removed: 1 });
  });

  it("measures named barrel imports with package side effects applied", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "import-size-fixture-"));
    const cleanPackage = join(fixtureRoot, "clean");
    const sideEffectPackage = join(fixtureRoot, "side-effect");
    const marker = deterministicMarker(4_096);

    try {
      await Promise.all([
        writeFixturePackage(cleanPackage, "fixture-clean", marker, false),
        writeFixturePackage(
          sideEffectPackage,
          "fixture-side-effect",
          marker,
          true
        )
      ]);
      const [clean, withSideEffect] = await Promise.all([
        measurePackageImports({
          packageDirectory: cleanPackage,
          revision: "clean"
        }),
        measurePackageImports({
          packageDirectory: sideEffectPackage,
          revision: "side-effect"
        })
      ]);
      const cleanTiny = findMeasurement(clean, "tiny");
      const cleanNoisy = findMeasurement(clean, "noisy");
      const sideEffectTiny = findMeasurement(withSideEffect, "tiny");

      expect(clean.measurements.map((item) => item.exportName)).toEqual([
        "noisy",
        "tiny"
      ]);
      expect(cleanTiny.gzipBytes).toBeLessThan(cleanNoisy.gzipBytes);
      expect(sideEffectTiny.gzipBytes).toBeGreaterThan(
        cleanTiny.gzipBytes + 1_000
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("sorts imports and rejects duplicate snapshot identities", () => {
    const parsed = parseImportSizeSnapshot({
      ...snapshot("sha", [measurement("z", 100), measurement("a", 200)]),
      measurements: [measurement("z", 100), measurement("a", 200)]
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.measurements.map((item) => item.exportName)).toEqual([
        "a",
        "z"
      ]);
    }

    const duplicate = parseImportSizeSnapshot(
      snapshot("sha", [measurement("Agent", 100), measurement("Agent", 100)])
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.location).toBe("snapshot.measurements");
    }
  });
});

async function writeFixturePackage(
  directory: string,
  packageName: string,
  marker: string,
  retainSideEffects: boolean
): Promise<void> {
  const dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "1.0.0",
        type: "module",
        sideEffects: retainSideEffects,
        exports: {
          ".": { import: "./dist/index.js" }
        }
      }),
      "utf8"
    ),
    writeFile(
      join(dist, "index.js"),
      'export { tiny } from "./tiny.js";\nexport { noisy } from "./noisy.js";\n',
      "utf8"
    ),
    writeFile(join(dist, "tiny.js"), "export const tiny = 1;\n", "utf8"),
    writeFile(
      join(dist, "noisy.js"),
      `console.log(${JSON.stringify(marker)});\nexport const noisy = ${JSON.stringify(marker)};\n`,
      "utf8"
    )
  ]);
}

function deterministicMarker(length: number): string {
  let state = 17;
  let marker = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    marker += String.fromCharCode(33 + (state % 90));
  }
  return marker;
}

function findMeasurement(
  snapshot: ImportSizeSnapshot,
  exportName: string
): ImportSizeMeasurement {
  const measurement = snapshot.measurements.find(
    (candidate) => candidate.exportName === exportName
  );
  if (measurement === undefined) {
    throw new Error(`Missing ${exportName} fixture measurement`);
  }
  return measurement;
}
