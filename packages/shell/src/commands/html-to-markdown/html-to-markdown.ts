/**
 * html-to-markdown command - Interface-backed HTML to Markdown conversion
 *
 * When a MarkdownConverter is provided via ShellOptions.markdown, this command
 * enables HTML to Markdown conversion in the shell.
 */

import type { MarkdownConverter } from "../../interfaces";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const htmlToMarkdownHelp = {
  name: "html-to-markdown",
  summary: "convert HTML to Markdown via pluggable MarkdownConverter",
  usage: "html-to-markdown [FILE...]",
  options: [
    "    --help    display this help and exit",
    "",
    "Reads HTML from stdin or files and outputs Markdown."
  ]
};

/**
 * Create an html-to-markdown command backed by a MarkdownConverter interface.
 */
export function createHtmlToMarkdownCommand(
  converter: MarkdownConverter
): Command {
  return {
    name: "html-to-markdown",
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (hasHelpFlag(args)) {
        return showHelp(htmlToMarkdownHelp);
      }

      let html = "";

      if (args.length > 0) {
        // Read from files
        const parts: string[] = [];
        for (const file of args) {
          try {
            const filePath = ctx.fs.resolvePath(ctx.cwd, file);
            const content = await ctx.fs.readFile(filePath);
            parts.push(content);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              stdout: "",
              stderr: `html-to-markdown: ${file}: ${msg}\n`,
              exitCode: 1
            };
          }
        }
        html = parts.join("\n");
      } else {
        // Read from stdin
        html = ctx.stdin;
      }

      if (!html.trim()) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      try {
        const markdown = await converter.convert(html);
        return {
          stdout: markdown.endsWith("\n") ? markdown : markdown + "\n",
          stderr: "",
          exitCode: 0
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          stdout: "",
          stderr: `html-to-markdown: ${msg}\n`,
          exitCode: 1
        };
      }
    }
  };
}
