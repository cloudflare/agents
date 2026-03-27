import type { ContextProvider } from "../context";

/**
 * Configuration for the AI Search context provider.
 */
export interface AiSearchConfig {
  /** R2 bucket name to use as data source when auto-creating the instance */
  bucket?: string;
  /** AI Search instance name (defaults to bucket name) */
  name?: string;
  /** Maximum number of search results (1-50, default 10) */
  maxResults?: number;
  /** Enable hybrid search (vector + keyword) */
  hybridSearch?: boolean;
}

/** An AI Search instance handle with search and items access */
interface AiSearchInstance {
  search(params: {
    messages: Array<{ role: string; content: string }>;
    ai_search_options?: {
      retrieval?: { max_num_results?: number };
    };
  }): Promise<{
    search_query: string;
    chunks: Array<{
      id: string;
      score: number;
      text: string;
      type: string;
      item: { key: string; metadata?: Record<string, unknown> };
    }>;
  }>;
  items: {
    upload(name: string, content: ArrayBuffer | string): Promise<unknown>;
  };
}

/**
 * The AI Search binding from wrangler `ai_search_namespaces`.
 * This is the `env.BINDING` object — not `env.AI`.
 */
export interface AiSearchBinding {
  list(): Promise<Array<{ id: string; [key: string]: unknown }>>;
  get(name: string): AiSearchInstance;
  create(config: {
    id: string;
    type?: string;
    source?: string;
    hybrid_search_enabled?: boolean;
  }): Promise<unknown>;
}

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
 *       name: "my-index",
 *       bucket: "my-docs"
 *     })
 *   })
 * ```
 */
export class AiSearchContextProvider implements ContextProvider {
  private binding: AiSearchBinding;
  private config: AiSearchConfig;
  private ready = false;

  constructor(binding: AiSearchBinding, config?: AiSearchConfig | string) {
    this.binding = binding;
    this.config =
      typeof config === "string" ? { name: config } : (config ?? {});
  }

  private getInstance(): AiSearchInstance {
    const name = this.config.name;
    return name
      ? this.binding.get(name)
      : (this.binding as unknown as AiSearchInstance);
  }

  private async ensureInstance(): Promise<void> {
    if (this.ready) return;

    const name = this.config.name;
    if (!name || !this.config.bucket) {
      this.ready = true;
      return;
    }

    try {
      const instances = await this.binding.list();
      const exists = instances.some((i) => i.id === name);

      if (!exists) {
        await this.binding.create({
          id: name,
          type: "r2",
          source: this.config.bucket,
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
        messages: [{ role: "user", content: query }],
        ai_search_options: this.config.maxResults
          ? { retrieval: { max_num_results: this.config.maxResults } }
          : undefined
      });
      return results.chunks.map((chunk) => chunk.text).join("\n\n");
    } catch (err) {
      console.error("[AiSearchContextProvider] search failed:", err);
      return "";
    }
  }
}
