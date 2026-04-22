import { Agent } from "../../index";
import {
  Session,
  AgentSessionProvider,
  AgentContextProvider,
  AgentSearchProvider,
  type SessionMessage,
  type StoredCompaction,
  type ContextBlock
} from "../../experimental/memory/session";

/**
 * Test Agent — full Session API
 */
export class TestSessionAgent extends Agent {
  session = new Session(new AgentSessionProvider(this));

  // ── Messages ────────────────────────────────────────────────────

  async appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<void> {
    await this.session.appendMessage(message, parentId);
  }

  async getMessage(id: string): Promise<SessionMessage | null> {
    return this.session.getMessage(id);
  }

  async updateMessage(message: SessionMessage): Promise<void> {
    await this.session.updateMessage(message);
  }

  async deleteMessages(ids: string[]): Promise<void> {
    await this.session.deleteMessages(ids);
  }

  async clearMessages(): Promise<void> {
    await this.session.clearMessages();
  }

  // ── History (tree) ──────────────────────────────────────────────

  async getHistory(leafId?: string): Promise<SessionMessage[]> {
    return this.session.getHistory(leafId);
  }

  async getLatestLeaf(): Promise<SessionMessage | null> {
    return this.session.getLatestLeaf();
  }

  async getBranches(messageId: string): Promise<SessionMessage[]> {
    return this.session.getBranches(messageId);
  }

  async getPathLength(): Promise<number> {
    return this.session.getPathLength();
  }

  // ── Compaction ──────────────────────────────────────────────────

  async addCompaction(
    summary: string,
    fromId: string,
    toId: string
  ): Promise<StoredCompaction> {
    return this.session.addCompaction(summary, fromId, toId);
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    return this.session.getCompactions();
  }

  // ── Search ──────────────────────────────────────────────────────

  async search(
    query: string
  ): Promise<Array<{ id: string; role: string; content: string }>> {
    return this.session.search(query);
  }
}

/**
 * Test Agent — context blocks with frozen snapshot
 */
export class TestSessionAgentWithContext extends Agent<Cloudflare.Env> {
  session = new Session(new AgentSessionProvider(this), {
    context: [
      {
        label: "memory",
        description: "Persistent notes",
        maxTokens: 500,
        provider: new AgentContextProvider(this, "memory")
      },
      {
        label: "soul",
        description: "Identity",
        provider: { get: async () => "You are helpful." }
      }
    ]
  });

  async freezeSystemPrompt(): Promise<string> {
    return this.session.freezeSystemPrompt();
  }

  async refreshSystemPrompt(): Promise<string> {
    return this.session.refreshSystemPrompt();
  }

  async setBlock(label: string, content: string): Promise<ContextBlock> {
    return this.session.replaceContextBlock(label, content);
  }

  getBlock(label: string): ContextBlock | null {
    return this.session.getContextBlock(label);
  }

  getBlocks(): ContextBlock[] {
    return this.session.getContextBlocks();
  }

  async getTools(): Promise<Record<string, unknown>> {
    return this.session.tools();
  }
}

type TestResult = { success: boolean; error?: string };

/**
 * Test Agent — searchable context block with FTS5
 */
export class TestSearchAgent extends Agent<Cloudflare.Env> {
  session = Session.create(this)
    .withContext("knowledge", {
      description: "Searchable knowledge base",
      provider: new AgentSearchProvider(this)
    })
    .withCachedPrompt();

  async testIndexAndSearch(): Promise<TestResult> {
    try {
      const tools = await this.session.tools();
      if (!tools.set_context)
        return { success: false, error: "no set_context" };
      if (!tools.search_context)
        return { success: false, error: "no search_context" };

      // Index some content
      type SetArgs = {
        label: string;
        content: string;
        metadata?: { title?: string; description?: string };
      };
      const setTool = tools.set_context as unknown as {
        execute: (args: SetArgs) => Promise<string>;
      };
      const searchTool = tools.search_context as unknown as {
        execute: (args: Record<string, string>) => Promise<string>;
      };

      await setTool.execute({
        label: "knowledge",
        metadata: { title: "meeting-notes" },
        content: "The deployment is scheduled for Friday with budget concerns"
      });
      await setTool.execute({
        label: "knowledge",
        metadata: { title: "design-doc" },
        content: "The API uses REST endpoints with JSON responses"
      });

      // Single word search
      const r1 = await searchTool.execute({
        label: "knowledge",
        query: "deployment"
      });
      if (!r1.includes("deployment"))
        return { success: false, error: "single word search failed" };

      // Multi-word search (non-adjacent terms)
      const r2 = await searchTool.execute({
        label: "knowledge",
        query: "deployment budget"
      });
      if (!r2.includes("budget"))
        return {
          success: false,
          error: "multi-word non-adjacent search failed"
        };

      // Search that should not match
      const r3 = await searchTool.execute({
        label: "knowledge",
        query: "nonexistent"
      });
      if (!r3.includes("No results"))
        return { success: false, error: "expected no results" };

      // Cross-key search
      const r4 = await searchTool.execute({
        label: "knowledge",
        query: "REST"
      });
      if (!r4.includes("REST"))
        return { success: false, error: "cross-key search failed" };

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async testInitLifecycle(): Promise<TestResult> {
    try {
      // The provider should have received label "knowledge" via init()
      const prompt = await this.session.freezeSystemPrompt();
      if (!prompt.includes("KNOWLEDGE"))
        return { success: false, error: "prompt missing KNOWLEDGE" };
      if (!prompt.includes("[searchable]"))
        return { success: false, error: "prompt missing [searchable] tag" };

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async testUpdateReplacesEntry(): Promise<TestResult> {
    try {
      const tools = await this.session.tools();
      type SetArgs = {
        label: string;
        content: string;
        metadata?: { title?: string; description?: string };
      };
      const setTool = tools.set_context as unknown as {
        execute: (args: SetArgs) => Promise<string>;
      };
      const searchTool = tools.search_context as unknown as {
        execute: (args: Record<string, string>) => Promise<string>;
      };

      // Index then replace — same title → same key → upsert
      await setTool.execute({
        label: "knowledge",
        metadata: { title: "doc" },
        content: "original content about cats"
      });
      await setTool.execute({
        label: "knowledge",
        metadata: { title: "doc" },
        content: "replaced content about dogs"
      });

      // Should find new content
      const r1 = await searchTool.execute({
        label: "knowledge",
        query: "dogs"
      });
      if (!r1.includes("replaced"))
        return { success: false, error: "replacement not found" };

      // Should not find old content
      const r2 = await searchTool.execute({
        label: "knowledge",
        query: "cats"
      });
      if (!r2.includes("No results"))
        return { success: false, error: "old content still searchable" };

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
