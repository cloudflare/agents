import { InMemoryFileSystem, type FileSystem } from "./file-system";

export type SourceEntryKind = "source" | "asset";

export interface SourceEntry {
  path: string;
  type?: "file" | "directory";
  kind?: SourceEntryKind;
  assetPath?: string;
  mimeType?: string;
  size?: number;
}

export interface SourceProvider {
  list(patterns?: string[]): Promise<SourceEntry[]>;
  readText(path: string): Promise<string | null>;
  readBytes?(path: string): Promise<Uint8Array | ArrayBuffer | null>;
}

export interface SourceProviderMaterializeOptions {
  patterns?: string[];
  virtualFiles?: Record<string, string>;
  virtualAssets?: Record<string, string | ArrayBuffer>;
}

export interface MaterializedSource {
  fileSystem: FileSystem;
  files: Record<string, string>;
  assets: Record<string, string | ArrayBuffer>;
  warnings: string[];
}

export function isSourceProvider(value: unknown): value is SourceProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    "list" in value &&
    typeof value.list === "function" &&
    "readText" in value &&
    typeof value.readText === "function"
  );
}

export async function materializeSourceProvider(
  source: SourceProvider,
  options: SourceProviderMaterializeOptions = {}
): Promise<MaterializedSource> {
  const files: Record<string, string> = {};
  const assets: Record<string, string | ArrayBuffer> = {};
  const warnings: string[] = [];

  const entries = await source.list(options.patterns);
  for (const entry of entries) {
    if (entry.type !== undefined && entry.type !== "file") continue;

    if ((entry.kind ?? "source") === "asset") {
      const assetPath = normalizeAssetPath(
        entry.assetPath ?? inferAssetPath(entry.path)
      );
      const content = await readAsset(source, entry.path);
      if (content === null) {
        warnings.push(
          `Skipped asset "${entry.path}" because it could not be read.`
        );
        continue;
      }
      assets[assetPath] = content;
      continue;
    }

    const path = normalizeSourcePath(entry.path);
    const content = await source.readText(entry.path);
    if (content === null) {
      warnings.push(
        `Skipped source file "${entry.path}" because it could not be read as text.`
      );
      continue;
    }
    files[path] = content;
  }

  for (const [path, content] of Object.entries(options.virtualFiles ?? {})) {
    const normalizedPath = normalizeSourcePath(path);
    if (normalizedPath in files) {
      warnings.push(
        `Virtual source file "${normalizedPath}" replaced a provider file with the same path.`
      );
    }
    files[normalizedPath] = content;
  }

  for (const [path, content] of Object.entries(options.virtualAssets ?? {})) {
    const normalizedPath = normalizeAssetPath(path);
    if (normalizedPath in assets) {
      warnings.push(
        `Virtual asset "${normalizedPath}" replaced a provider asset with the same path.`
      );
    }
    assets[normalizedPath] = content;
  }

  return {
    files,
    assets,
    warnings,
    fileSystem: new InMemoryFileSystem(files)
  };
}

function normalizeSourcePath(path: string) {
  return path.replace(/^\/+/, "");
}

function normalizeAssetPath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function inferAssetPath(path: string) {
  const normalized = normalizeSourcePath(path);
  if (normalized.startsWith("public/")) {
    return normalized.slice("public".length);
  }
  return normalized;
}

async function readAsset(
  source: SourceProvider,
  path: string
): Promise<string | ArrayBuffer | null> {
  const bytes = source.readBytes ? await source.readBytes(path) : null;
  if (bytes !== null && bytes !== undefined) {
    if (bytes instanceof ArrayBuffer) return bytes;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }
  return source.readText(path);
}
