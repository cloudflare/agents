import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryFileSystem } from "../file-system";
import { installDependencies } from "../installer";

const TAR_BLOCK_SIZE = 512;
const TEST_REGISTRY = "https://registry.example.test";

type TestTarEntry = {
  path: string;
  content?: string;
  type?: "file" | "directory" | "pax-global-header";
  /** Directory portion stored separately in the USTAR prefix field. */
  ustarPrefix?: string;
};

function writeTarHeaderField(
  header: Uint8Array,
  offset: number,
  value: string
): void {
  header.set(new TextEncoder().encode(value), offset);
}

function createTarHeader(entry: TestTarEntry, contentSize: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const typeFlag =
    entry.type === "directory"
      ? "5"
      : entry.type === "pax-global-header"
        ? "g"
        : "0";

  writeTarHeaderField(header, 0, entry.path);
  writeTarHeaderField(header, 100, "0000644\0");
  writeTarHeaderField(header, 108, "0000000\0");
  writeTarHeaderField(header, 116, "0000000\0");
  writeTarHeaderField(
    header,
    124,
    `${contentSize.toString(8).padStart(11, "0")}\0`
  );
  writeTarHeaderField(header, 136, "00000000000\0");
  writeTarHeaderField(header, 148, "        ");
  writeTarHeaderField(header, 156, typeFlag);
  writeTarHeaderField(header, 257, "ustar\0");
  writeTarHeaderField(header, 263, "00");
  if (entry.ustarPrefix) {
    writeTarHeaderField(header, 345, entry.ustarPrefix);
  }

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarHeaderField(
    header,
    148,
    `${checksum.toString(8).padStart(6, "0")}\0 `
  );

  return header;
}

async function createGzippedTarball(
  entries: TestTarEntry[]
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const archiveBlocks: Uint8Array[] = [];

  for (const entry of entries) {
    const content = encoder.encode(entry.content ?? "");
    archiveBlocks.push(createTarHeader(entry, content.byteLength));

    if (content.byteLength > 0) {
      const paddedContent = new Uint8Array(
        Math.ceil(content.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
      );
      paddedContent.set(content);
      archiveBlocks.push(paddedContent);
    }
  }

  archiveBlocks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));

  const archiveSize = archiveBlocks.reduce(
    (total, block) => total + block.byteLength,
    0
  );
  const archive = new Uint8Array(archiveSize);
  let archiveOffset = 0;
  for (const block of archiveBlocks) {
    archive.set(block, archiveOffset);
    archiveOffset += block.byteLength;
  }

  const compressedStream = new Blob([archive])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressedStream).arrayBuffer());
}

async function installTarballFixture(
  packageName: string,
  entries: TestTarEntry[]
): Promise<InMemoryFileSystem> {
  const version = "1.0.0";
  const tarballUrl = `${TEST_REGISTRY}/fixtures/${encodeURIComponent(packageName)}.tgz`;
  const tarball = await createGzippedTarball(entries);
  const metadata = {
    name: packageName,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name: packageName,
        version,
        dist: { tarball: tarballUrl }
      }
    }
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === tarballUrl ? new Response(tarball) : Response.json(metadata);
  });

  const fileSystem = new InMemoryFileSystem({
    "package.json": JSON.stringify({
      dependencies: { [packageName]: version }
    })
  });
  const result = await installDependencies(fileSystem, {
    registry: TEST_REGISTRY
  });

  expect(result).toEqual({
    installed: [`${packageName}@${version}`],
    warnings: []
  });

  return fileSystem;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installDependencies tarball root handling", () => {
  it("installs a DefinitelyTyped-style tarball relative to its named root", async () => {
    const fileSystem = await installTarballFixture("@types/react", [
      { path: "react/", type: "directory" },
      { path: "react/package.json", content: '{"name":"@types/react"}' },
      { path: "react/index.d.ts", content: "export as namespace React;" }
    ]);

    expect(fileSystem.read("node_modules/@types/react/package.json")).toBe(
      '{"name":"@types/react"}'
    );
    expect(fileSystem.read("node_modules/@types/react/index.d.ts")).toBe(
      "export as namespace React;"
    );
    expect(
      fileSystem.read("node_modules/@types/react/react/index.d.ts")
    ).toBeNull();
  });

  it("continues to strip the conventional package root", async () => {
    const fileSystem = await installTarballFixture("conventional", [
      { path: "package/", type: "directory" },
      { path: "package/package.json", content: '{"name":"conventional"}' },
      { path: "package/index.js", content: "export default true;" }
    ]);

    expect(fileSystem.read("node_modules/conventional/package.json")).toBe(
      '{"name":"conventional"}'
    );
    expect(fileSystem.read("node_modules/conventional/index.js")).toBe(
      "export default true;"
    );
  });

  it("reconstructs USTAR-prefixed paths before detecting the archive root", async () => {
    const longEntryPath =
      "dist/compiled/next-server/dist_client_dev_noop-turbopack-hmr_js-turbo-experimental.runtime.dev.js";
    const fileSystem = await installTarballFixture("ustar-layout", [
      {
        path: "package/package.json",
        content: '{"name":"ustar-layout"}'
      },
      {
        path: longEntryPath,
        ustarPrefix: "package",
        content: "export const runtime = true;"
      }
    ]);

    expect(fileSystem.read("node_modules/ustar-layout/package.json")).toBe(
      '{"name":"ustar-layout"}'
    );
    expect(fileSystem.read(`node_modules/ustar-layout/${longEntryPath}`)).toBe(
      "export const runtime = true;"
    );
    expect(
      fileSystem.read("node_modules/ustar-layout/package/package.json")
    ).toBeNull();
  });

  it("normalizes leading dot segments and ignores tar metadata", async () => {
    const fileSystem = await installTarballFixture("prefixed", [
      {
        path: "pax_global_header",
        content: "22 comment=test data\n",
        type: "pax-global-header"
      },
      { path: "./prefixed", type: "directory" },
      { path: "./prefixed/package.json", content: '{"name":"prefixed"}' },
      { path: "./prefixed/index.js", content: "export default 1;" }
    ]);

    expect(fileSystem.read("node_modules/prefixed/package.json")).toBe(
      '{"name":"prefixed"}'
    );
    expect(fileSystem.read("node_modules/prefixed/index.js")).toBe(
      "export default 1;"
    );
  });

  it("leaves an archive with top-level files unchanged", async () => {
    const fileSystem = await installTarballFixture("flat-layout", [
      { path: "package.json", content: '{"name":"flat-layout"}' },
      { path: "index.js", content: "export default 1;" },
      { path: "lib/value.js", content: "export const value = 1;" }
    ]);

    expect(fileSystem.read("node_modules/flat-layout/package.json")).toBe(
      '{"name":"flat-layout"}'
    );
    expect(fileSystem.read("node_modules/flat-layout/lib/value.js")).toBe(
      "export const value = 1;"
    );
  });

  it("leaves an archive with multiple roots unchanged", async () => {
    const fileSystem = await installTarballFixture("multiple-roots", [
      { path: "server/index.js", content: "export const runtime = true;" },
      { path: "client/index.js", content: "export const browser = true;" }
    ]);

    expect(fileSystem.read("node_modules/multiple-roots/server/index.js")).toBe(
      "export const runtime = true;"
    );
    expect(fileSystem.read("node_modules/multiple-roots/client/index.js")).toBe(
      "export const browser = true;"
    );
  });

  it("does not partially strip a wrapper when a top-level file is present", async () => {
    const fileSystem = await installTarballFixture("mixed-layout", [
      { path: "package/package.json", content: '{"name":"mixed-layout"}' },
      { path: "package/index.js", content: "export default 1;" },
      { path: "README.md", content: "fixture readme" }
    ]);

    expect(
      fileSystem.read("node_modules/mixed-layout/package/package.json")
    ).toBe('{"name":"mixed-layout"}');
    expect(fileSystem.read("node_modules/mixed-layout/package/index.js")).toBe(
      "export default 1;"
    );
    expect(fileSystem.read("node_modules/mixed-layout/README.md")).toBe(
      "fixture readme"
    );
  });
});
