import type { ToolSet } from "ai";
import {
  createAITools,
  type CreateAIToolsOptions
} from "@cloudflare/computer/tools";

const READ_RESULT_GUIDANCE =
  "Returns an object; the file text is in result.content. Parse result.content, never the whole result. If the file contains JSON, JSON.parse(result.content) returns the written JSON value; access fields such as .value as needed.";

/** Add result-shape guidance to Computer's native tools without changing them. */
export function createRlmWorkspaceTools(
  options: CreateAIToolsOptions
): ToolSet {
  const tools = createAITools(options);
  const read = tools.read;
  if (!read) return tools;
  const original =
    typeof read.description === "string"
      ? read.description
      : "Read a workspace file.";
  read.description = `${original} ${READ_RESULT_GUIDANCE}`;
  return tools;
}
