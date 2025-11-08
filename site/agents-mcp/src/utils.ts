import { create, insert, search } from "@orama/orama";
import { RecursiveChunker } from "@chonkiejs/core";
import { env } from "cloudflare:workers";
import { Effect, Schedule } from "effect";

interface Document {
  fileName: string;
  content: string;
  url: string;
}

interface GitHubTreeItem {
  path: string;
  type: string;
  sha: string;
  url: string;
}

const KV_KEY = "docs-v0";
const DOCS_REPO_API =
  "https://api.github.com/repos/cloudflare/agents/git/trees/main?recursive=1";
const TTL_SECONDS = 24 * 60 * 60; // 1 day

const fetchWithRetry = (url: string, useAuth = true) =>
  Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        "User-Agent": "Cloudflare-Agents-MCP/1.0",
        Accept: "application/vnd.github+json"
      };

      const response = await fetch(url, { headers });

      if (!response.ok) {
        console.error(
          `HTTP ${response.status} for ${url}: ${response.statusText}`
        );
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    },
    catch: (error) => {
      console.error(`Fetch error for ${url}:`, error);
      return error as Error;
    }
  }).pipe(
    Effect.retry(
      Schedule.exponential("100 millis").pipe(
        Schedule.intersect(Schedule.recurs(3))
      )
    ),
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.error(`Failed after retries for ${url}:`, error)
      )
    )
  );

const fetchDocsFromGitHub = async (): Promise<Document[]> => {
  const treeEffect = fetchWithRetry(DOCS_REPO_API).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => {
          const text = await response.text();
          return JSON.parse(text) as { tree: GitHubTreeItem[] };
        },
        catch: (error) => {
          console.error("Failed to parse GitHub tree JSON:", error);
          return error as Error;
        }
      })
    )
  );

  const treeData = await Effect.runPromise(treeEffect);

  const docFiles = treeData.tree.filter(
    (item: GitHubTreeItem) =>
      item.path.startsWith("docs/") && item.path.endsWith(".md")
  );

  const docs: Document[] = [];
  const chunker = await RecursiveChunker.create({
    chunkSize: 800
  });

  for (const file of docFiles) {
    const contentUrl = `https://raw.githubusercontent.com/cloudflare/agents/main/${file.path}`;

    const contentEffect = fetchWithRetry(contentUrl).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: (error) => error as Error
        })
      )
    );

    try {
      const content = await Effect.runPromise(contentEffect);
      const chunks = await chunker.chunk(content);

      for (const chunk of chunks) {
        docs.push({
          fileName: file.path,
          content: chunk.text,
          url: contentUrl
        });
      }
    } catch (error) {
      console.error(`Failed to fetch/chunk ${file.path}:`, error);
    }
  }

  return docs;
};

const getCachedDocs = async (): Promise<Document[] | null> => {
  const cached = await env.DOCS_KV.get(KV_KEY, "json");

  if (!cached) {
    return null;
  }

  return cached as Document[];
};

const cacheDocs = async (docs: Document[]): Promise<void> => {
  await env.DOCS_KV.put(KV_KEY, JSON.stringify(docs), {
    expirationTtl: TTL_SECONDS
  });
};

export const fetchAndBuildIndex = async () => {
  let docs = await getCachedDocs();

  if (!docs) {
    // If not cached, fetch from GitHub, chunk, and cache to KV
    docs = await fetchDocsFromGitHub();
    await cacheDocs(docs);
  }

  // Build the search index from docs
  const docsDb = create({
    schema: {
      fileName: "string",
      content: "string",
      url: "string"
    } as const
  });

  for (const doc of docs) {
    await insert(docsDb, doc);
  }

  return docsDb;
};

export const formatResults = (
  results: Awaited<ReturnType<typeof search>>,
  query: string,
  k: number
): string => {
  const hitCount = results.count;
  const elapsed = results.elapsed.formatted;

  let output = `**Search Results**\n\n`;
  output += `Found ${hitCount} result${hitCount !== 1 ? "s" : ""} for "${query}" (${elapsed})\n\n`;
  output += `Showing top ${k} result${k !== 1 ? "s" : ""}:\n\n`;
  output += `---\n\n`;

  for (const hit of results.hits) {
    const doc = hit.document as Document;
    output += `**${doc.fileName}**\n`;
    output += `[Full content](${doc.url})\n\n`;
    output += `${doc.content}\n\n`;
    output += `---\n\n`;
  }

  return output;
};
