import { Agent } from "../../index";
import {
  Session,
  AgentSessionProvider,
  AgentContextProvider,
} from "../../experimental/memory/session";

/**
 * Test agent for multi-session isolation tests.
 * Each test method creates sessions with different sessionIds and verifies isolation.
 */
export class TestMultiSessionAgent extends Agent {
  private makeSession(sessionId: string) {
    return new Session(new AgentSessionProvider(this, sessionId), {
      context: [
        { label: "soul", defaultContent: "You are helpful.", readonly: true },
        {
          label: "memory",
          description: "Facts",
          maxTokens: 1100,
          provider: new AgentContextProvider(this, `memory_${sessionId}`),
        },
      ],
      promptStore: new AgentContextProvider(this, `_prompt_${sessionId}`),
    });
  }

  async testSessionIsolation(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("chat-a");
      const s2 = this.makeSession("chat-b");

      s1.appendMessage({ id: "a1", role: "user", parts: [{ type: "text", text: "hello from A" }] });
      s1.appendMessage({ id: "a2", role: "assistant", parts: [{ type: "text", text: "reply A" }] });

      s2.appendMessage({ id: "b1", role: "user", parts: [{ type: "text", text: "hello from B" }] });

      const h1 = s1.getHistory();
      const h2 = s2.getHistory();

      if (h1.length !== 2) return { success: false, error: `s1 has ${h1.length} msgs, expected 2` };
      if (h2.length !== 1) return { success: false, error: `s2 has ${h2.length} msgs, expected 1` };
      if (h1[0].id !== "a1") return { success: false, error: `s1[0].id=${h1[0].id}, expected a1` };
      if (h2[0].id !== "b1") return { success: false, error: `s2[0].id=${h2[0].id}, expected b1` };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testCompactionIsolation(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("compact-a");
      const s2 = this.makeSession("compact-b");

      // Add messages to s1
      for (let i = 0; i < 5; i++) {
        s1.appendMessage({ id: `ca-${i}`, role: i % 2 === 0 ? "user" : "assistant", parts: [{ type: "text", text: `msg ${i}` }] });
      }

      // Add messages to s2
      s2.appendMessage({ id: "cb-0", role: "user", parts: [{ type: "text", text: "s2 msg" }] });
      s2.appendMessage({ id: "cb-1", role: "assistant", parts: [{ type: "text", text: "s2 reply" }] });

      // Compact s1 only
      s1.addCompaction("Summary of ca-1 to ca-3", "ca-1", "ca-3");

      const h1 = s1.getHistory();
      const h2 = s2.getHistory();

      // s1 should have compaction applied (3 msgs replaced by summary)
      const hasCompaction = h1.some(m => m.id.startsWith("compaction_"));
      if (!hasCompaction) return { success: false, error: "s1 missing compaction overlay" };

      // s2 should be unaffected
      if (h2.length !== 2) return { success: false, error: `s2 has ${h2.length} msgs, expected 2` };
      const s2HasCompaction = h2.some(m => m.id.startsWith("compaction_"));
      if (s2HasCompaction) return { success: false, error: "s2 has unexpected compaction" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testSystemPromptPersistence(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("prompt-persist");

      // First call renders and stores
      const p1 = await s1.freezeSystemPrompt();
      if (!p1.includes("SOUL")) return { success: false, error: "prompt missing SOUL" };
      if (!p1.includes("You are helpful.")) return { success: false, error: "prompt missing identity" };

      // Second call returns stored value
      const p2 = await s1.freezeSystemPrompt();
      if (p1 !== p2) return { success: false, error: "prompt not frozen" };

      // New Session instance with same sessionId should get stored prompt
      const s1b = this.makeSession("prompt-persist");
      const p3 = await s1b.freezeSystemPrompt();
      if (p1 !== p3) return { success: false, error: "prompt not persisted across instances" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testSystemPromptRefresh(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("prompt-refresh");

      const p1 = await s1.freezeSystemPrompt();
      if (!p1.includes("SOUL")) return { success: false, error: "initial prompt missing SOUL" };

      // Write to memory block
      await s1.replaceContextBlock("memory", "user likes coffee");

      // Still frozen
      const p2 = await s1.freezeSystemPrompt();
      if (p1 !== p2) return { success: false, error: "prompt changed before refresh" };

      // Refresh
      const p3 = await s1.refreshSystemPrompt();
      if (!p3.includes("user likes coffee")) return { success: false, error: "refresh didn't pick up changes" };
      if (p3 === p1) return { success: false, error: "refresh returned same prompt" };

      // Now frozen at new value
      const p4 = await s1.freezeSystemPrompt();
      if (p4 !== p3) return { success: false, error: "prompt not frozen after refresh" };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async testClearIsolation(): Promise<{ success: boolean; error?: string }> {
    try {
      const s1 = this.makeSession("clear-a");
      const s2 = this.makeSession("clear-b");

      s1.appendMessage({ id: "cl-a1", role: "user", parts: [{ type: "text", text: "s1 msg" }] });
      s2.appendMessage({ id: "cl-b1", role: "user", parts: [{ type: "text", text: "s2 msg" }] });

      // Clear s1 only
      s1.clearMessages();

      const h1 = s1.getHistory();
      const h2 = s2.getHistory();

      if (h1.length !== 0) return { success: false, error: `s1 has ${h1.length} msgs after clear` };
      if (h2.length !== 1) return { success: false, error: `s2 has ${h2.length} msgs, expected 1` };

      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
