import { Agent } from "agents";
import { Workspace } from "@cloudflare/computer";
import { WorkspaceFiles } from "../../workspace-files";
import { createWorkspaceTools } from "../../tools/workspace";
import type { WorkspaceToolsOptions } from "../../tools/workspace";

export class TestAssistantToolsAgent extends Agent {
  workspace = new Workspace({ storage: this.ctx.storage });
  private files = new WorkspaceFiles(this.workspace);

  private getTools() {
    return createWorkspaceTools(this.workspace);
  }

  // Seed workspace with files for testing
  async seed(files: Array<{ path: string; content: string }>): Promise<void> {
    for (const f of files) {
      await this.files.write(f.path, f.content);
    }
  }

  async seedBytes(
    path: string,
    bytes: number[],
    _mimeType?: string
  ): Promise<void> {
    await this.files.write(path, new Uint8Array(bytes));
  }

  async seedDir(path: string): Promise<void> {
    await this.files.mkdir(path, { recursive: true });
  }

  async toolRead(
    path: string,
    offset?: number,
    limit?: number
  ): Promise<unknown> {
    const tools = this.getTools();
    return tools.read.execute!(
      { path, offset, limit },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async toolReadModelOutput(
    path: string,
    offset?: number,
    limit?: number
  ): Promise<unknown> {
    const tools = this.getTools();
    const input = { path, offset, limit };
    type ReadModelOutputOptions = Parameters<
      NonNullable<typeof tools.read.toModelOutput>
    >[0];
    const output = (await tools.read.execute!(input, {
      toolCallId: "test",
      messages: [],
      abortSignal: new AbortController().signal,
      context: {}
    })) as ReadModelOutputOptions["output"];

    return tools.read.toModelOutput?.({
      toolCallId: "test",
      input,
      output
    });
  }

  async toolWrite(path: string, content: string): Promise<unknown> {
    const tools = this.getTools();
    return tools.write.execute!(
      { path, content },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async toolEdit(
    path: string,
    old_string: string,
    new_string: string
  ): Promise<unknown> {
    const tools = this.getTools();
    return tools.edit.execute!(
      { path, old_string, new_string },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async toolList(
    path?: string,
    limit?: number,
    offset?: number
  ): Promise<unknown> {
    const tools = this.getTools();
    return tools.list.execute!(
      { path: path ?? "/", limit, offset },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async toolFind(pattern: string): Promise<unknown> {
    const tools = this.getTools();
    return tools.find.execute!(
      { pattern },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async toolGrep(
    query: string,
    include?: string,
    fixedString?: boolean,
    caseSensitive?: boolean,
    contextLines?: number
  ): Promise<unknown> {
    const tools = this.getTools();
    return tools.grep.execute!(
      { query, include, fixedString, caseSensitive, contextLines },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async toolBash(
    script: string,
    cwd?: string,
    options?: Exclude<WorkspaceToolsOptions["bash"], boolean>
  ): Promise<unknown> {
    const tools = options
      ? createWorkspaceTools(this.workspace, { bash: options })
      : this.getTools();
    const bash = tools.bash;
    if (!bash?.execute) throw new Error("bash tool is not available");
    return bash.execute(
      { script, cwd },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async seedLargeFile(path: string, sizeBytes: number): Promise<void> {
    // Generate content of approximately the requested size
    const line = "x".repeat(99) + "\n"; // 100 bytes per line
    const lines = Math.ceil(sizeBytes / 100);
    const content = line.repeat(lines);
    await this.files.write(path, content);
  }
}
