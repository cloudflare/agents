import type { ContextProvider } from "../context";

/**
 * Context provider backed by Cloudflare AI Search.
 *
 * Uses the `ai_search_namespaces` wrangler binding for direct access.
 *
 * - `get()` returns empty string so the block renders in the system prompt
 *   (the AI sees it exists and can use `search_context` to query it).
 * - `set()` uploads content to AI Search as a document for indexing.
 * - `search()` queries AI Search and returns matching text chunks.
 *
 * The AI Search instance is created lazily on first use if it doesn't exist.
 *
 * @example
 * ```ts
 * // wrangler.jsonc:
 * // "ai_search_namespaces": [{ "binding": "KNOWLEDGE", "namespace": "my-index" }]
 *
 * import { AiSearchContextProvider } from "agents/experimental/memory/session";
 *
 * Session.create(this)
 *   .withContext("knowledge", {
 *     description: "Product documentation",
 *     provider: new AiSearchContextProvider(env.KNOWLEDGE, {
 *       id: "my-index",  // or user-1234 or chat-1234 or any name you would like
 *     })
 *   })
 * ```
 */
export class AiSearchContextProvider implements ContextProvider {
  private binding: AiSearchNamespace;
  private config: AiSearchConfig;
  private ready = false;

  constructor(binding: AiSearchNamespace, config?: AiSearchConfig | string) {
    this.binding = binding;

    // If no name is received, fallback into a single instance named "default" for all requests
    this.config =
      typeof config === "string"
        ? { id: config }
        : (config ?? { id: "default" });
  }

  private getInstance(): AiSearchInstance {
    return this.binding.get(this.config.id);
  }

  private async ensureInstance(): Promise<void> {
    if (this.ready) return;

    try {
      const instance = await this.binding.get(this.config.id);

      try {
        const _ = await instance.info();
      } catch (err) {
        await this.binding.create({
          id: this.config.id,
          hybrid_search_enabled: this.config.hybridSearch
        });
      }
    } catch (err) {
      console.error("[AiSearchContextProvider] ensureInstance failed:", err);
    }

    this.ready = true;
  }

  async get(): Promise<string | null> {
    return "";
  }

  async set(content: string): Promise<void> {
    try {
      await this.ensureInstance();
      const instance = this.getInstance();
      const name = `context-${Date.now()}.txt`;
      await instance.items.upload(name, content);
    } catch (err) {
      console.error("[AiSearchContextProvider] set failed:", err);
    }
  }

  async search(query: string): Promise<string> {
    try {
      await this.ensureInstance();
      const instance = this.getInstance();
      const results = await instance.search({
        messages: [{ role: "user", content: query }]
      });
      return results.chunks.map((chunk) => chunk.text).join("\n\n");
    } catch (err) {
      console.error("[AiSearchContextProvider] search failed:", err);
      return "";
    }
  }
}
