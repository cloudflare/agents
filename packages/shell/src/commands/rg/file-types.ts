/**
 * Built-in file type definitions for rg
 *
 * Maps type names to file extensions and glob patterns.
 * Based on ripgrep's default type definitions.
 */

import { createUserRegex } from "../../regex/index";
import { nullPrototype } from "../query-engine/safe-object";

export interface FileType {
  extensions: string[];
  globs: string[];
}

/**
 * Built-in file type definitions
 * Use `rg --type-list` to see all types in real ripgrep
 */
const FILE_TYPES = nullPrototype<Record<string, FileType>>({
  // Web languages
  js: { extensions: [".js", ".mjs", ".cjs", ".jsx"], globs: [] },
  ts: { extensions: [".ts", ".tsx", ".mts", ".cts"], globs: [] },
  html: { extensions: [".html", ".htm", ".xhtml"], globs: [] },
  css: { extensions: [".css", ".scss", ".sass", ".less"], globs: [] },
  json: { extensions: [".json", ".jsonc", ".json5"], globs: [] },
  xml: { extensions: [".xml", ".xsl", ".xslt"], globs: [] },

  // Systems languages
  c: { extensions: [".c", ".h"], globs: [] },
  cpp: {
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"],
    globs: []
  },
  rust: { extensions: [".rs"], globs: [] },
  go: { extensions: [".go"], globs: [] },
  zig: { extensions: [".zig"], globs: [] },

  // JVM languages
  java: { extensions: [".java"], globs: [] },
  kotlin: { extensions: [".kt", ".kts"], globs: [] },
  scala: { extensions: [".scala", ".sc"], globs: [] },
  clojure: { extensions: [".clj", ".cljc", ".cljs", ".edn"], globs: [] },

  // Scripting languages
  py: { extensions: [".py", ".pyi", ".pyw"], globs: [] },
  rb: {
    extensions: [".rb", ".rake", ".gemspec"],
    globs: ["Rakefile", "Gemfile"]
  },
  php: { extensions: [".php", ".phtml", ".php3", ".php4", ".php5"], globs: [] },
  perl: { extensions: [".pl", ".pm", ".pod", ".t"], globs: [] },
  lua: { extensions: [".lua"], globs: [] },

  // Shell
  sh: {
    extensions: [".sh", ".bash", ".zsh", ".fish"],
    globs: [".bashrc", ".zshrc", ".profile"]
  },
  bat: { extensions: [".bat", ".cmd"], globs: [] },
  ps: { extensions: [".ps1", ".psm1", ".psd1"], globs: [] },

  // Data/Config
  yaml: { extensions: [".yaml", ".yml"], globs: [] },
  toml: { extensions: [".toml"], globs: ["Cargo.toml", "pyproject.toml"] },
  ini: { extensions: [".ini", ".cfg", ".conf"], globs: [] },
  csv: { extensions: [".csv", ".tsv"], globs: [] },

  // Documentation
  md: { extensions: [".md", ".mdx", ".markdown", ".mdown", ".mkd"], globs: [] },
  markdown: {
    extensions: [".md", ".mdx", ".markdown", ".mdown", ".mkd"],
    globs: []
  },
  rst: { extensions: [".rst"], globs: [] },
  txt: { extensions: [".txt", ".text"], globs: [] },
  tex: { extensions: [".tex", ".ltx", ".sty", ".cls"], globs: [] },

  // Other
  sql: { extensions: [".sql"], globs: [] },
  graphql: { extensions: [".graphql", ".gql"], globs: [] },
  proto: { extensions: [".proto"], globs: [] },
  make: {
    extensions: [".mk", ".mak"],
    globs: ["Makefile", "GNUmakefile", "makefile"]
  },
  docker: {
    extensions: [],
    globs: ["Dockerfile", "Dockerfile.*", "*.dockerfile"]
  },
  tf: { extensions: [".tf", ".tfvars"], globs: [] }
});

/**
 * Mutable file type registry for runtime type modifications
 * Supports --type-add and --type-clear flags
 */
export class FileTypeRegistry {
  private types: Map<string, FileType>;

  constructor() {
    // Clone default types
    this.types = new Map(
      Object.entries(FILE_TYPES).map(([name, type]) => [
        name,
        { extensions: [...type.extensions], globs: [...type.globs] }
      ])
    );
  }

  /**
   * Add a type definition
   * Format: "name:pattern" where pattern can be:
   * - "*.ext" - glob pattern
   * - "include:other" - include patterns from another type
   */
  addType(spec: string): void {
    const colonIdx = spec.indexOf(":");
    if (colonIdx === -1) return;

    const name = spec.slice(0, colonIdx);
    const pattern = spec.slice(colonIdx + 1);

    if (pattern.startsWith("include:")) {
      // Include patterns from another type
      const otherName = pattern.slice(8);
      const other = this.types.get(otherName);
      if (other) {
        const existing = this.types.get(name) || { extensions: [], globs: [] };
        existing.extensions.push(...other.extensions);
        existing.globs.push(...other.globs);
        this.types.set(name, existing);
      }
    } else {
      // Add glob pattern
      const existing = this.types.get(name) || { extensions: [], globs: [] };
      // If pattern is like "*.ext", add to extensions
      if (pattern.startsWith("*.") && !pattern.slice(2).includes("*")) {
        const ext = pattern.slice(1); // Keep the dot
        if (!existing.extensions.includes(ext)) {
          existing.extensions.push(ext);
        }
      } else {
        // Add as glob pattern
        if (!existing.globs.includes(pattern)) {
          existing.globs.push(pattern);
        }
      }
      this.types.set(name, existing);
    }
  }

  /**
   * Clear all patterns from a type
   */
  clearType(name: string): void {
    const existing = this.types.get(name);
    if (existing) {
      existing.extensions = [];
      existing.globs = [];
    }
  }

  /**
   * Get a type by name
   */
  getType(name: string): FileType | undefined {
    return this.types.get(name);
  }

  /**
   * Get all type names
   */
  getAllTypes(): Map<string, FileType> {
    return this.types;
  }

  /**
   * Check if a filename matches any of the specified types
   */
  matchesType(filename: string, typeNames: string[]): boolean {
    const lowerFilename = filename.toLowerCase();

    for (const typeName of typeNames) {
      // Special case: 'all' matches any file with a recognized type
      if (typeName === "all") {
        if (this.matchesAnyType(filename)) {
          return true;
        }
        continue;
      }

      const fileType = this.types.get(typeName);
      if (!fileType) continue;

      // Check extensions
      for (const ext of fileType.extensions) {
        if (lowerFilename.endsWith(ext)) {
          return true;
        }
      }

      // Check globs
      for (const glob of fileType.globs) {
        if (glob.includes("*")) {
          const pattern = glob.replace(/\./g, "\\.").replace(/\*/g, ".*");
          if (createUserRegex(`^${pattern}$`, "i").test(filename)) {
            return true;
          }
        } else if (lowerFilename === glob.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a filename matches any recognized type
   */
  private matchesAnyType(filename: string): boolean {
    const lowerFilename = filename.toLowerCase();

    for (const fileType of this.types.values()) {
      for (const ext of fileType.extensions) {
        if (lowerFilename.endsWith(ext)) {
          return true;
        }
      }

      for (const glob of fileType.globs) {
        if (glob.includes("*")) {
          const pattern = glob.replace(/\./g, "\\.").replace(/\*/g, ".*");
          if (createUserRegex(`^${pattern}$`, "i").test(filename)) {
            return true;
          }
        } else if (lowerFilename === glob.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }
}

/**
 * Format type list for --type-list output
 */
export function formatTypeList(): string {
  const lines: string[] = [];
  for (const [name, type] of Object.entries(FILE_TYPES).sort()) {
    const patterns: string[] = [];
    for (const ext of type.extensions) {
      patterns.push(`*${ext}`);
    }
    for (const glob of type.globs) {
      patterns.push(glob);
    }
    lines.push(`${name}: ${patterns.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
