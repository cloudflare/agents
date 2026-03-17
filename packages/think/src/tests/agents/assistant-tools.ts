import { Agent } from "agents";
import { Workspace } from "@cloudflare/isolate";
import { createWorkspaceTools } from "../../tools/workspace";

export class TestAssistantToolsAgent extends Agent<Record<string, unknown>> {
  workspace = new Workspace(this);

  private getTools() {
    return createWorkspaceTools(this.workspace);
  }

  // Seed workspace with files for testing
  async seed(files: Array<{ path: string; content: string }>): Promise<void> {
    for (const f of files) {
      const parent = f.path.replace(/\/[^/]+$/, "");
      if (parent && parent !== "/") {
        await this.workspace.mkdir(parent, { recursive: true });
      }
      await this.workspace.writeFile(f.path, f.content);
    }
  }

  async seedDir(path: string): Promise<void> {
    await this.workspace.mkdir(path, { recursive: true });
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
        abortSignal: new AbortController().signal
      }
    );
  }

  async toolWrite(path: string, content: string): Promise<unknown> {
    const tools = this.getTools();
    return tools.write.execute!(
      { path, content },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal
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
        abortSignal: new AbortController().signal
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
        abortSignal: new AbortController().signal
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
        abortSignal: new AbortController().signal
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
        abortSignal: new AbortController().signal
      }
    );
  }

  async seedLargeFile(path: string, sizeBytes: number): Promise<void> {
    const parent = path.replace(/\/[^/]+$/, "");
    if (parent && parent !== "/") {
      this.workspace.mkdir(parent, { recursive: true });
    }
    // Generate content of approximately the requested size
    const line = "x".repeat(99) + "\n"; // 100 bytes per line
    const lines = Math.ceil(sizeBytes / 100);
    const content = line.repeat(lines);
    await this.workspace.writeFile(path, content);
  }
}
