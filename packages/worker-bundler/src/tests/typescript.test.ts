import { describe, expect, it, vi } from "vitest";
import { InMemoryFileSystem } from "../file-system";
import { createTypescriptLanguageService } from "../typescript";

const tsconfig = JSON.stringify({ compilerOptions: { lib: ["es2024"] } });

describe("createTypescriptLanguageService", () => {
  it("creates a type checker in the workers test environment", async () => {
    vi.stubGlobal("localStorage", undefined);

    const fileSystem = new InMemoryFileSystem({
      "tsconfig.json": tsconfig,
      "index.ts": "const values: Array<number> = [];"
    });

    const environment = await createTypescriptLanguageService({ fileSystem });

    expect(
      environment.languageService.getProgram()!.getSourceFile("index.ts")
    ).toBeDefined();
    expect(
      environment.languageService.getSemanticDiagnostics("index.ts")
    ).toEqual([]);
  });

  it("updates the backing filesystem and refreshes diagnostics", async () => {
    const fileSystem = new InMemoryFileSystem({
      "tsconfig.json": tsconfig,
      "index.ts": 'const value: number = "nope";'
    });

    const environment = await createTypescriptLanguageService({ fileSystem });

    expect(
      environment.languageService.getSemanticDiagnostics("index.ts")
    ).toHaveLength(1);

    environment.fileSystem.write("index.ts", "const value: number = 1;");

    expect(fileSystem.read("index.ts")).toBe("const value: number = 1;");
    expect(
      environment.languageService.getSemanticDiagnostics("index.ts")
    ).toEqual([]);
  });

  it("deletes files from the backing filesystem", async () => {
    const fileSystem = new InMemoryFileSystem({
      "tsconfig.json": tsconfig,
      "index.ts": "export const value = 1;"
    });

    const environment = await createTypescriptLanguageService({ fileSystem });

    environment.fileSystem.delete("index.ts");

    expect(fileSystem.read("index.ts")).toBeNull();
    expect(
      environment.languageService.getProgram()!.getSourceFile("index.ts")
    ).toBeUndefined();
  });

  it("reports semantic compiler errors", async () => {
    const fileSystem = new InMemoryFileSystem({
      "tsconfig.json": tsconfig,
      "index.ts": 'const value: number = "nope";'
    });

    const environment = await createTypescriptLanguageService({ fileSystem });

    const diagnostics =
      environment.languageService.getSemanticDiagnostics("index.ts");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(2322);
    expect(diagnostics[0]?.messageText).toBe(
      "Type 'string' is not assignable to type 'number'."
    );
  });

  it("uses default compiler options when no tsconfig.json is present", async () => {
    const fileSystem = new InMemoryFileSystem({
      "index.ts": "const value = 1;"
    });

    const environment = await createTypescriptLanguageService({ fileSystem });

    expect(
      environment.languageService.getProgram()!.getSourceFile("index.ts")
    ).toBeDefined();
    expect(
      environment.languageService.getSemanticDiagnostics("index.ts")
    ).toEqual([]);
  });

  it("writes a new file not in the original root set", async () => {
    const fileSystem = new InMemoryFileSystem({
      "tsconfig.json": tsconfig,
      "index.ts": 'import { helper } from "./utils";'
    });

    const environment = await createTypescriptLanguageService({ fileSystem });

    expect(
      environment.languageService.getSemanticDiagnostics("index.ts")
    ).not.toHaveLength(0);

    environment.fileSystem.write(
      "utils.ts",
      "export function helper(): void {}"
    );

    expect(fileSystem.read("utils.ts")).toBe(
      "export function helper(): void {}"
    );
    expect(
      environment.languageService.getProgram()!.getSourceFile("utils.ts")
    ).toBeDefined();
    expect(
      environment.languageService.getSemanticDiagnostics("utils.ts")
    ).toEqual([]);
  });
});
