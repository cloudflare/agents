import type { ContextProvider } from "../context";

/**
 * Context provider backed by Cloudflare AI Search (AutoRAG).
 *
 * - `get()` returns empty string so the block renders in the system prompt
 *   (the AI sees it exists and can use `search_context` to query it).
 * - `set()` is a no-op — AI Search indexing is configured externally
 *   via data sources, not programmatically.
 * - `search()` queries AutoRAG and returns matching content chunks.
 */
export class AiSearchContextProvider implements ContextProvider {
  private autorag: ReturnType<Ai["autorag"]>;

  constructor(ai: Ai, instanceName: string) {
    this.autorag = ai.autorag(instanceName);
  }

  async get(): Promise<string | null> {
    return "";
  }

  async set(_content: string): Promise<void> {
    // AI Search indexing is configured externally via data sources.
    // In future, this could push to R2 which AI Search indexes.
  }

  async search(query: string): Promise<string[]> {
    const results = await this.autorag.search({ query });
    return results.data.map((r) => r.content.map((c) => c.text).join("\n"));
  }
}
