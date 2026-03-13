/**
 * AWK Interpreter Types
 */

export type AwkValue = string | number;

/**
 * File system interface for AWK file operations
 */
export interface AwkFileSystem {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  appendFile: (path: string, content: string) => Promise<void>;
  resolvePath: (cwd: string, path: string) => string;
}
