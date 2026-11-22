/**
 * The public API of every published package, read from the built `.d.ts` of
 * each `package.json` export.
 *
 *   tsx scripts/public-api.ts                 check against the allow-list
 *   tsx scripts/public-api.ts --report <file> write names and signatures (for diffs)
 *   tsx scripts/public-api.ts --allow-list    rewrite the allow-list from the build
 *
 * The check fails when a package gains an export subpath, or a public entry
 * gains an exported symbol, that is not on `scripts/public-api-allow-list.json`.
 * Removals pass. Entries documented as internal (sibling-package support)
 * are listed in `INTERNAL_ENTRIES`: their symbols are not checked, but the
 * subpath itself must still be on the allow-list.
 *
 * The allow-list was taken from 2ddd6f160, before the slim-hosts work. Add to
 * it only for an export that is meant to be public.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import fg from "fast-glob";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const ALLOW_LIST = resolve(ROOT, "scripts/public-api-allow-list.json");

/** Entries documented as internal sibling-package support, not a public API. */
const INTERNAL_ENTRIES = new Set(["agents/chat", "agents/internal"]);

type Entry = { key: string; types: string };
type Report = Record<string, Record<string, string>>;
type AllowList = Record<string, string[] | "internal">;

function typesPath(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target.endsWith(".d.ts") ? target : undefined;
  }
  if (target && typeof target === "object") {
    const conditions = target as Record<string, unknown>;
    if (typeof conditions.types === "string") return conditions.types;
    for (const value of Object.values(conditions)) {
      const found = typesPath(value);
      if (found) return found;
    }
  }
  return undefined;
}

function entries(): Entry[] {
  const found: Entry[] = [];
  for (const file of fg.sync("packages/*/package.json", {
    cwd: ROOT,
    absolute: true
  })) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.private || !pkg.exports) continue;
    for (const [subpath, target] of Object.entries(
      pkg.exports as Record<string, unknown>
    )) {
      const types = typesPath(target);
      const key =
        subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
      found.push({
        key,
        types: types ? resolve(dirname(file), types) : ""
      });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

function signature(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration = target.declarations?.[0];
  const flags = ts.TypeFormatFlags.NoTruncation;
  if (!declaration) return "unknown";
  if (target.flags & ts.SymbolFlags.TypeAlias) {
    return `type ${checker.typeToString(
      checker.getDeclaredTypeOfSymbol(target),
      undefined,
      flags | ts.TypeFormatFlags.InTypeAlias
    )}`;
  }
  if (target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
    const type = checker.getDeclaredTypeOfSymbol(target);
    const members = checker
      .getPropertiesOfType(type)
      .filter((property) => !property.name.startsWith("__@"))
      // Members inherited from a dependency are the dependency's API.
      .filter(
        (property) =>
          !(
            property.declarations?.[0]?.getSourceFile().fileName ?? ""
          ).includes("/node_modules/")
      )
      .map(
        (property) =>
          `${property.name}: ${checker.typeToString(
            checker.getTypeOfSymbolAtLocation(property, declaration),
            undefined,
            flags
          )}`
      )
      .sort();
    const isClass = (target.flags & ts.SymbolFlags.Class) !== 0;
    const statics = isClass
      ? ` new${checker.typeToString(
          checker.getTypeOfSymbolAtLocation(target, declaration),
          undefined,
          flags
        )}`
      : "";
    return `${isClass ? "class" : "interface"} { ${members.join("; ")} }${statics}`;
  }
  return checker.typeToString(
    checker.getTypeOfSymbolAtLocation(target, declaration),
    undefined,
    flags
  );
}

/**
 * The public and protected members of an exported class, instance and
 * static: what a caller or a subclass can reach. Private members and `_`-prefixed internals
 * are left out.
 */
function classMembers(checker: ts.TypeChecker, symbol: ts.Symbol): string[] {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  if (!(target.flags & ts.SymbolFlags.Class)) return [];
  const members: string[] = [];
  const add = (property: ts.Symbol, prefix: string) => {
    const name = property.name;
    if (name.startsWith("_") || name.startsWith("#") || name === "prototype") {
      return;
    }
    const declaration = property.declarations?.[0];
    if (
      declaration &&
      ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private
    ) {
      return;
    }
    // Members inherited from a dependency (PartySocket, Error) are the
    // dependency's API: a dependency update must not fail this check.
    const file = declaration?.getSourceFile().fileName ?? "";
    if (file.includes("/node_modules/") || declaration === undefined) return;
    members.push(`${prefix}${name}`);
  };
  for (const property of checker.getPropertiesOfType(
    checker.getDeclaredTypeOfSymbol(target)
  )) {
    add(property, "");
  }
  // Static members: properties of the constructor (`typeof Class`).
  const declaration = target.declarations?.[0];
  if (declaration) {
    for (const property of checker.getPropertiesOfType(
      checker.getTypeOfSymbolAtLocation(target, declaration)
    )) {
      add(property, "static ");
    }
  }
  return members.sort();
}

function report(withSignatures: boolean): Report {
  const list = entries();
  const missing = list.filter(
    (entry) => entry.types !== "" && !existsSync(entry.types)
  );
  if (missing.length > 0) {
    throw new Error(
      `Build first: no declarations for ${missing
        .map((entry) => entry.key)
        .join(", ")}`
    );
  }
  const files = list.map((entry) => entry.types).filter((f) => f !== "");
  const program = ts.createProgram(files, {
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    types: [],
    strict: true
  });
  const checker = program.getTypeChecker();
  const out: Report = {};
  for (const entry of list) {
    const source = entry.types ? program.getSourceFile(entry.types) : undefined;
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    const names: Record<string, string> = {};
    if (moduleSymbol) {
      for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
        names[symbol.name] = withSignatures ? signature(checker, symbol) : "";
        for (const member of classMembers(checker, symbol)) {
          names[`${symbol.name}.${member}`] = "";
        }
      }
    }
    out[entry.key] = Object.fromEntries(
      Object.entries(names).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === "--report") {
  writeFileSync(args[1], `${JSON.stringify(report(true), null, 1)}\n`);
} else if (args[0] === "--allow-list") {
  const allow: AllowList = {};
  for (const [key, names] of Object.entries(report(false))) {
    allow[key] = INTERNAL_ENTRIES.has(key) ? "internal" : Object.keys(names);
  }
  writeFileSync(ALLOW_LIST, `${JSON.stringify(allow, null, 2)}\n`);
} else {
  const allow = JSON.parse(readFileSync(ALLOW_LIST, "utf8")) as AllowList;
  const problems: string[] = [];
  for (const [key, names] of Object.entries(report(false))) {
    const allowed = allow[key];
    if (allowed === undefined) {
      problems.push(`${key}: new export subpath`);
      continue;
    }
    if (allowed === "internal") continue;
    const known = new Set(allowed);
    for (const name of Object.keys(names)) {
      if (!known.has(name)) problems.push(`${key}: new export \`${name}\``);
    }
  }
  if (problems.length > 0) {
    console.error(
      `Public API grew beyond ${relative(ROOT, ALLOW_LIST)}:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nNew capabilities and helpers stay internal (export them from agents/internal and mark them @internal)." +
        "\nIf this export is meant to be public, add it to the allow-list in the same PR."
    );
    process.exit(1);
  }
  console.log("Public API: no export beyond the allow-list.");
}
