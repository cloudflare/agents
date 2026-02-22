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
const CHUNK_SIZE = 2000;
const MIN_CHARS_PER_CHUNK = 500;

const chunker = await RecursiveChunker.create({
  chunkSize: CHUNK_SIZE,
  minCharactersPerChunk: MIN_CHARS_PER_CHUNK
});

const fetchWithRetry = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        "User-Agent": "Cloudflare-Agents-MCP/1.0",
        Accept: "application/vnd.github+json"
      };

      // @ts-expect-error - GITHUB_TOKEN is not defined in the environment variables
      const githubToken = env.GITHUB_TOKEN;
      if (githubToken) {
        headers["Authorization"] = `Bearer ${githubToken}`;
      }

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

const fetchDocsFromGitHub = Effect.gen(function* () {
  const treeData = yield* fetchWithRetry(DOCS_REPO_API).pipe(
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

  const docFiles = treeData.tree.filter(
    (item: GitHubTreeItem) =>
      item.path.startsWith("docs/") && item.path.endsWith(".md")
  );

  const docs: Document[] = [];

  for (const file of docFiles) {
    const contentUrl = `https://raw.githubusercontent.com/cloudflare/agents/main/${file.path}`;

    const contentResult = yield* fetchWithRetry(contentUrl).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.text(),
          catch: (error) => error as Error
        })
      ),
      Effect.flatMap((content) => Effect.promise(() => chunker.chunk(content))),
      Effect.catchAll((error) => {
        console.error(`Failed to fetch/chunk ${file.path}:`, error);
        return Effect.succeed([]);
      })
    );

    for (const chunk of contentResult) {
      docs.push({
        fileName: file.path,
        content: chunk.text,
        url: contentUrl
      });
    }
  }

  return docs;
});

const getCachedDocs = Effect.tryPromise({
  try: () => env.DOCS_KV.get(KV_KEY, "json") as Promise<Document[] | null>,
  catch: (error) => error as Error
});

const cacheDocs = (docs: Document[]) =>
  Effect.tryPromise({
    try: () =>
      env.DOCS_KV.put(KV_KEY, JSON.stringify(docs), {
        expirationTtl: TTL_SECONDS
      }),
    catch: (error) => error as Error
  });

export const fetchAndBuildIndex = Effect.gen(function* () {
  const cached = yield* getCachedDocs;

  let docs: Document[];

  if (!cached) {
    docs = yield* fetchDocsFromGitHub;
    yield* cacheDocs(docs);
  } else {
    docs = cached;
  }

  const docsDb = yield* Effect.sync(() =>
    create({
      schema: {
        fileName: "string",
        content: "string",
        url: "string"
      } as const,
      components: {
        tokenizer: {
          stemming: true,
          language: "english"
        }
      }
    })
  );

  for (const doc of docs) {
    yield* Effect.sync(() => insert(docsDb, doc));
  }

  return docsDb;
});

export const formatResults = (
  results: Awaited<ReturnType<typeof search>>,
  query: string,
  k: number
): string => {
  const hitCount = results.count;
  const elapsed = results.elapsed.formatted;

  let output = `**Search Results**\n\n`;
  output += `Found ${hitCount} result${hitCount !== 1 ? "s" : ""} for "${query}" (${elapsed})\n\n`;

  if (hitCount === 0) {
    output += `No results found. Try using different keywords or modify the spelling.`;
    return output;
  }

  output += `Showing top ${Math.min(k, hitCount)} result${Math.min(k, hitCount) !== 1 ? "s" : ""}:\n\n`;
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
