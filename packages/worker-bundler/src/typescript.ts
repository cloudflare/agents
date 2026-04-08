/**
 * This file adapts the virtual TypeScript environment machinery from
 * `@typescript/vfs` to this package's filesystem abstraction.
 *
 * The original implementation lives in the TypeScript Website repository:
 * https://github.com/microsoft/TypeScript-Website/tree/v2/packages/typescript-vfs
 */
import {
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment
} from "@typescript/vfs";
import type TypeScript from "typescript";
import type { FileSystem } from "./file-system.js";
import { fetchPackageFiles } from "./installer.js";
import ts from "./vendor/typescript.browser.js";

const TYPECHECK_ROOT_FILE_PATTERN = /(?:\.d)?\.(?:ts|tsx|cts|mts)$/;

type CreateTypeCheckerOptions = {
  fileSystem: FileSystem;
};

/**
 * Creates a TypeScript language service for the provided filesystem. Compiler
 * options are read from a `tsconfig.json` file in the filesystem; if none is
 * present, TypeScript's default options are used.
 *
 * The returned `fileSystem` wraps the input filesystem and mirrors subsequent
 * writes and deletes into the virtual TypeScript environment, so callers
 * should keep using that wrapper after initialization if they want later
 * edits to be reflected in diagnostics and completions.
 *
 * @param options.fileSystem Project files to expose to the language service.
 * A `tsconfig.json` at the root of the filesystem is parsed for compiler
 * options.
 * @returns The wrapped filesystem and the underlying TypeScript language
 * service.
 */
export async function createTypescriptLanguageService(
  options: CreateTypeCheckerOptions
) {
  const compilerOptions = parseTsConfig(options.fileSystem);

  // The compiler won't accept non-typescript files as root files
  const keys = options.fileSystem
    .list()
    .filter((path) => TYPECHECK_ROOT_FILE_PATTERN.test(path));
  const system = await createSystem(options.fileSystem, compilerOptions);

  const typescriptEnv = createVirtualTypeScriptEnvironment(
    system,
    keys,
    ts,
    compilerOptions
  );

  return {
    fileSystem: new TypescriptFileSystem(options.fileSystem, typescriptEnv),
    languageService: typescriptEnv.languageService
  };
}

/**
 * A `FileSystem` wrapper that keeps a virtual TypeScript environment in sync
 * with filesystem mutations.
 */
class TypescriptFileSystem implements FileSystem {
  constructor(
    private innerFs: FileSystem,
    private typescriptEnv: VirtualTypeScriptEnvironment
  ) {}
  read(path: string): string | null {
    return this.innerFs.read(path);
  }
  write(path: string, content: string): void {
    this.innerFs.write(path, content);
    this.typescriptEnv.updateFile(path, content);
  }
  delete(path: string): void {
    this.innerFs.delete(path);
    this.typescriptEnv.deleteFile(path);
  }
  list(prefix?: string): string[] {
    return this.innerFs.list(prefix);
  }
  flush(): Promise<void> {
    return this.innerFs.flush();
  }
}

/**
 * Reads and parses `tsconfig.json` from the filesystem, returning the
 * resulting compiler options. Falls back to TypeScript's defaults when no
 * `tsconfig.json` is present.
 */
function parseTsConfig(fileSystem: FileSystem): TypeScript.CompilerOptions {
  const configContent = fileSystem.read("tsconfig.json");
  if (configContent === null) {
    return {};
  }

  const { config, error } = ts.readConfigFile(
    "tsconfig.json",
    () => configContent
  );
  if (error !== undefined) {
    throw new Error(
      `tsconfig.json: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`
    );
  }

  const normalizePath = (path: string): string =>
    path.startsWith("/") ? path.slice(1) : path;

  const parseConfigHost: TypeScript.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: (rootDir, extensions) => {
      const prefix = rootDir === "/" ? undefined : normalizePath(rootDir);
      return fileSystem
        .list(prefix)
        .filter((f) => extensions.some((ext) => f.endsWith(ext)))
        .map((f) => `/${f}`);
    },
    fileExists: (path) => fileSystem.read(normalizePath(path)) !== null,
    readFile: (path) => fileSystem.read(normalizePath(path)) ?? undefined
  };

  const { options } = ts.parseJsonConfigFileContent(
    config,
    parseConfigHost,
    "/"
  );
  return options;
}

// Adapted from @typescript/vfs's MIT-licensed createSystem implementation
// https://github.com/microsoft/TypeScript-Website/blob/119f931a639c9215a27311fde459c6db0b8718e4/packages/typescript-vfs/src/index.ts#L494
async function createSystem(
  fileSystem: FileSystem,
  compileOptions: TypeScript.CompilerOptions
): Promise<TypeScript.System> {
  const libs = compileOptions.lib ?? [];

  const libraryFiles = await createDefaultTypeScriptLibMap();

  const normalizeProjectPath = (path: string): string =>
    path.startsWith("/") ? path.slice(1) : path;

  function readFile(fileName: string): string | undefined {
    const normalizedPath = normalizeProjectPath(fileName);

    const file = fileSystem.read(normalizedPath);
    if (file !== null) {
      return file;
    }

    // If it's a d.ts file we first check if the file is a "blessed" lib by
    // being included in compilerOptions.libs, and then fallback to being a
    // file present in typescript's `lib/lib.*.d.ts`.
    if (normalizedPath.endsWith(".d.ts")) {
      if (libs.includes(normalizedPath.slice(0, -5))) {
        return libraryFiles.get(`lib.${normalizedPath}`);
      }

      if (libraryFiles.has(normalizedPath)) {
        return libraryFiles.get(normalizedPath);
      }
    }

    return undefined;
  }

  function listFiles(prefix?: string): string[] {
    const result = new Set<string>(
      fileSystem.list(
        prefix === undefined ? undefined : normalizeProjectPath(prefix)
      )
    );

    for (const path of libraryFiles.keys()) {
      if (prefix === undefined || path.startsWith(prefix)) {
        result.add(path);
      }
    }

    return Array.from(result);
  }

  function unimplemented(): never {
    throw new Error("unimplemented");
  }

  return {
    args: [],
    newLine: "\n",
    useCaseSensitiveFileNames: true,
    getDirectories: () => [],
    getCurrentDirectory: () => "/",
    readFile,
    directoryExists: (directory: string) =>
      listFiles(normalizeProjectPath(directory)).length > 0,
    fileExists: (fileName: string) => readFile(fileName) !== undefined,
    resolvePath: (path: string) => path,
    readDirectory: (directory: string) =>
      directory === "/" ? listFiles() : listFiles(directory),
    writeFile: (path, content) => {
      fileSystem.write(normalizeProjectPath(path), content);
    },
    deleteFile: (path) => {
      fileSystem.delete(normalizeProjectPath(path));
    },
    getExecutingFilePath: unimplemented,
    createDirectory: unimplemented,
    exit: unimplemented,
    write: unimplemented
  };
}

// Fetches the lib types from the TypeScript NPM package.
async function createDefaultTypeScriptLibMap(): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  const files = await fetchPackageFiles("typescript", {
    name: "typescript",
    version: "6.0.2",
    dist: {
      tarball: "https://registry.npmjs.org/typescript/-/typescript-6.0.2.tgz"
    }
  });

  for (const [file, contents] of Object.entries(files)) {
    if (!file.startsWith("lib/lib.") || !file.endsWith(".d.ts")) continue;

    result.set(`${file.substring(4)}`, contents);
  }

  return result;
}
