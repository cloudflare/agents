import type { Workspace } from "../../../workspace";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";
import { createEditTool } from "./edit";
import { createListTool } from "./list";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createDeleteTool } from "./delete";
import {
  workspaceReadOps,
  workspaceWriteOps,
  workspaceEditOps,
  workspaceListOps,
  workspaceFindOps,
  workspaceDeleteOps,
  workspaceGrepOps
} from "./types";

export { createReadTool } from "./read";
export { createWriteTool } from "./write";
export { createEditTool } from "./edit";
export { createListTool } from "./list";
export { createFindTool } from "./find";
export { createGrepTool } from "./grep";
export { createDeleteTool } from "./delete";
export { createExecuteTool } from "./execute";
export type { CreateExecuteToolOptions } from "./execute";
export { createExtensionTools } from "./extensions";
export type { ExtensionToolsOptions } from "./extensions";

export type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  ListOperations,
  FindOperations,
  DeleteOperations,
  GrepOperations
} from "./types";

/**
 * Create a complete set of AI SDK tools backed by a Workspace instance.
 *
 * ```ts
 * import { Workspace } from "agents/workspace";
 * import { createWorkspaceTools } from "agents/experimental/assistant";
 *
 * class MyAgent extends Agent<Env> {
 *   workspace = new Workspace(this);
 *
 *   async onChatMessage() {
 *     const tools = createWorkspaceTools(this.workspace);
 *     const result = streamText({ model, tools, messages });
 *     return result.toUIMessageStreamResponse();
 *   }
 * }
 * ```
 */
export function createWorkspaceTools(workspace: Workspace) {
  return {
    read: createReadTool({ ops: workspaceReadOps(workspace) }),
    write: createWriteTool({ ops: workspaceWriteOps(workspace) }),
    edit: createEditTool({ ops: workspaceEditOps(workspace) }),
    list: createListTool({ ops: workspaceListOps(workspace) }),
    find: createFindTool({ ops: workspaceFindOps(workspace) }),
    grep: createGrepTool({ ops: workspaceGrepOps(workspace) }),
    delete: createDeleteTool({ ops: workspaceDeleteOps(workspace) })
  };
}
