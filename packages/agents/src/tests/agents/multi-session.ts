import { Agent } from "../../index";
import {
  Session,
  SessionManager,
  AgentContextProvider
} from "../../experimental/memory/session";

/**
 * Test agent for multi-session isolation tests.
 * Each test method creates sessions with different sessionIds and verifies isolation.
 */
export class TestMultiSessionAgent extends Agent {
  private makeSession(sessionId: string) {
    return Session.create(this)
      .forSession(sessionId)
      .withContext("soul", {
        defaultContent: "You are helpful.",
        readonly: true
      })
      .withContext("memory", { description: "Facts", maxTokens: 1100 })
      .withCachedPrompt();
  }

  async testSessionIsolation(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("chat-a");
      const s2 = this.makeSession("chat-b");

      s1.appendMessage({
        id: "a1",
        role: "user",
        parts: [{ type: "text", text: "hello from A" }]
      });
      s1.appendMessage({
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "reply A" }]
      });

      s2.appendMessage({
        id: "b1",
        role: "user",
        parts: [{ type: "text", text: "hello from B" }]
      });

      const h1 = s1.getHistory();
      const h2 = s2.getHistory();

      if (h1.length !== 2)
        return {
          success: false,
          error: `s1 has ${h1.length} msgs, expected 2`
        };
      if (h2.length !== 1)
        return {
          success: false,
          error: `s2 has ${h2.length} msgs, expected 1`
        };
      if (h1[0].id !== "a1")
        return { success: false, error: `s1[0].id=${h1[0].id}, expected a1` };
      if (h2[0].id !== "b1")
        return { success: false, error: `s2[0].id=${h2[0].id}, expected b1` };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testCompactionIsolation(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const s1 = this.makeSession("compact-a");
      const s2 = this.makeSession("compact-b");

      // Add messages to s1
      for (let i = 0; i < 5; i++) {
        s1.appendMessage({
          id: `ca-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [{ type: "text", text: `msg ${i}` }]
        });
      }

      // Add messages to s2
      s2.appendMessage({
        id: "cb-0",
        role: "user",
        parts: [{ type: "text", text: "s2 msg" }]
      });
      s2.appendMessage({
        id: "cb-1",
        role: "assistant",
        parts: [{ type: "text", text: "s2 reply" }]
      });

      // Compact s1 only
      s1.addCompaction("Summary of ca-1 to ca-3", "ca-1", "ca-3");

      const h1 = s1.getHistory();
      const h2 = s2.getHistory();

      // s1 should have compaction applied (3 msgs replaced by summary)
      const hasCompaction = h1.some((m) => m.id.startsWith("compaction_"));
      if (!hasCompaction)
        return { success: false, error: "s1 missing compaction overlay" };

      // s2 should be unaffected
      if (h2.length !== 2)
        return {
          success: false,
          error: `s2 has ${h2.length} msgs, expected 2`
        };
      const s2HasCompaction = h2.some((m) => m.id.startsWith("compaction_"));
      if (s2HasCompaction)
        return { success: false, error: "s2 has unexpected compaction" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testSystemPromptPersistence(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const s1 = this.makeSession("prompt-persist");

      // First call renders and stores
      const p1 = await s1.freezeSystemPrompt();
      if (!p1.includes("SOUL"))
        return { success: false, error: "prompt missing SOUL" };
      if (!p1.includes("You are helpful."))
        return { success: false, error: "prompt missing identity" };

      // Second call returns stored value
      const p2 = await s1.freezeSystemPrompt();
      if (p1 !== p2) return { success: false, error: "prompt not frozen" };

      // New Session instance with same sessionId should get stored prompt
      const s1b = this.makeSession("prompt-persist");
      const p3 = await s1b.freezeSystemPrompt();
      if (p1 !== p3)
        return {
          success: false,
          error: "prompt not persisted across instances"
        };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testSystemPromptRefresh(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const s1 = this.makeSession("prompt-refresh");

      const p1 = await s1.freezeSystemPrompt();
      if (!p1.includes("SOUL"))
        return { success: false, error: "initial prompt missing SOUL" };

      // Write to memory block
      await s1.replaceContextBlock("memory", "user likes coffee");

      // Still frozen
      const p2 = await s1.freezeSystemPrompt();
      if (p1 !== p2)
        return { success: false, error: "prompt changed before refresh" };

      // Refresh
      const p3 = await s1.refreshSystemPrompt();
      if (!p3.includes("user likes coffee"))
        return { success: false, error: "refresh didn't pick up changes" };
      if (p3 === p1)
        return { success: false, error: "refresh returned same prompt" };

      // Now frozen at new value
      const p4 = await s1.freezeSystemPrompt();
      if (p4 !== p3)
        return { success: false, error: "prompt not frozen after refresh" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testClearIsolation(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("clear-a");
      const s2 = this.makeSession("clear-b");

      s1.appendMessage({
        id: "cl-a1",
        role: "user",
        parts: [{ type: "text", text: "s1 msg" }]
      });
      s2.appendMessage({
        id: "cl-b1",
        role: "user",
        parts: [{ type: "text", text: "s2 msg" }]
      });

      // Clear s1 only
      s1.clearMessages();

      const h1 = s1.getHistory();
      const h2 = s2.getHistory();

      if (h1.length !== 0)
        return {
          success: false,
          error: `s1 has ${h1.length} msgs after clear`
        };
      if (h2.length !== 1)
        return {
          success: false,
          error: `s2 has ${h2.length} msgs, expected 1`
        };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── SessionManager tests ──────────────────────────────────────

  async testManagerCreateAndGet(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const mgr = SessionManager.create(this)
        .withContext("soul", { defaultContent: "helpful", readonly: true })
        .withContext("memory", { description: "Facts", maxTokens: 1100 });

      const info = mgr.create("Test Chat");
      if (!info.id) return { success: false, error: "no id" };
      if (info.name !== "Test Chat")
        return { success: false, error: `name=${info.name}` };

      // get returns the same session
      const s2 = mgr.get(info.id);
      if (!s2) return { success: false, error: "get returned null" };

      // non-existent returns null
      if (mgr.get("nope") !== null)
        return { success: false, error: "get non-existent should be null" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testManagerList(): Promise<{ success: boolean; error?: string }> {
    try {
      const mgr = SessionManager.create(this);
      mgr.create("Alpha");
      mgr.create("Beta");

      const list = mgr.list();
      if (list.length < 2)
        return { success: false, error: `list.length=${list.length}` };
      const names = list.map((s) => s.name);
      if (!names.includes("Alpha"))
        return { success: false, error: "missing Alpha" };
      if (!names.includes("Beta"))
        return { success: false, error: "missing Beta" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testManagerDelete(): Promise<{ success: boolean; error?: string }> {
    try {
      const mgr = SessionManager.create(this);
      const info = mgr.create("ToDelete");
      const s = mgr.getSession(info.id);

      s.appendMessage({
        id: "d1",
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      });
      if (s.getHistory().length !== 1)
        return { success: false, error: "msg not added" };

      mgr.delete(info.id);
      if (mgr.get(info.id) !== null)
        return { success: false, error: "session still exists after delete" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testManagerRename(): Promise<{ success: boolean; error?: string }> {
    try {
      const mgr = SessionManager.create(this);
      const info = mgr.create("Original");
      mgr.rename(info.id, "Renamed");

      const list = mgr.list();
      const found = list.find((s) => s.id === info.id);
      if (found?.name !== "Renamed")
        return { success: false, error: `name=${found?.name}` };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testManagerSearch(): Promise<{ success: boolean; error?: string }> {
    try {
      const mgr = SessionManager.create(this);
      const i1 = mgr.create("Chat1");
      const i2 = mgr.create("Chat2");

      mgr.getSession(i1.id).appendMessage({
        id: "ms1",
        role: "user",
        parts: [{ type: "text", text: "I love TypeScript" }]
      });
      mgr.getSession(i2.id).appendMessage({
        id: "ms2",
        role: "user",
        parts: [{ type: "text", text: "Python is great" }]
      });

      const results = mgr.search("TypeScript");
      if (results.length === 0)
        return { success: false, error: "no search results" };
      const hasTS = results.some((r) => r.content.includes("TypeScript"));
      if (!hasTS)
        return { success: false, error: "TypeScript not found in results" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testSessionSearchTool(): Promise<{ success: boolean; error?: string }> {
    try {
      const mgr = SessionManager.create(this).withContext("memory", {
        description: "Facts",
        maxTokens: 1100
      });

      const sInfo = mgr.create("SearchTest");
      const session = mgr.getSession(sInfo.id);
      session.appendMessage({
        id: "st1",
        role: "user",
        parts: [
          { type: "text", text: "Remember: deploy to production on Fridays" }
        ]
      });

      // session.tools() has update_context only
      const sessionTools = await session.tools();
      if (!sessionTools.update_context)
        return { success: false, error: "no update_context tool" };
      if (sessionTools.session_search)
        return {
          success: false,
          error: "session_search should not be on session"
        };

      // manager.tools() has session_search
      const mgrTools = mgr.tools();
      if (!mgrTools.session_search)
        return { success: false, error: "no session_search on manager" };

      // Merged tools work
      const allTools = { ...sessionTools, ...mgrTools };
      const searchTool = allTools.session_search as unknown as {
        execute: (args: { query: string }) => Promise<string>;
      };
      const result = await searchTool.execute({ query: "deploy production" });
      if (result === "No results found.")
        return { success: false, error: "search returned no results" };
      if (!result.includes("deploy"))
        return {
          success: false,
          error: `search result missing 'deploy': ${result}`
        };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testContextBlockProxies(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const s1 = this.makeSession("ctx-proxy");
      // Need to load blocks first
      await s1.freezeSystemPrompt();

      // replaceContextBlock
      const block = await s1.replaceContextBlock("memory", "fact1");
      if (block.content !== "fact1")
        return { success: false, error: `content=${block.content}` };

      // appendContextBlock
      const block2 = await s1.appendContextBlock("memory", "\nfact2");
      if (!block2.content.includes("fact2"))
        return { success: false, error: `append failed: ${block2.content}` };

      // getContextBlock
      const got = s1.getContextBlock("memory");
      if (!got?.content.includes("fact1"))
        return { success: false, error: `get failed: ${got?.content}` };

      // getContextBlocks
      const all = s1.getContextBlocks();
      if (all.length !== 2)
        return {
          success: false,
          error: `blocks count=${all.length}, expected 2`
        };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testAgentContextProvider(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const provider = new AgentContextProvider(this, "test_block");

      // Initially null
      const initial = await provider.get();
      if (initial !== null)
        return { success: false, error: `initial=${initial}` };

      // Set
      await provider.set("hello world");
      const val = await provider.get();
      if (val !== "hello world") return { success: false, error: `get=${val}` };

      // Overwrite
      await provider.set("updated");
      const val2 = await provider.get();
      if (val2 !== "updated")
        return { success: false, error: `updated=${val2}` };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
