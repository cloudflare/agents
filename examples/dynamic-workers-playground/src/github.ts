interface GitHubContent {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url?: string;
}

function parseGitHubUrl(urlString: string): {
  owner: string;
  repo: string;
  branch: string;
  path: string;
} | null {
  try {
    const url = new URL(urlString);

    if (url.hostname !== "github.com") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];

    if (!owner || !repo) {
      return null;
    }

    let branch = "main";
    let path = "";

    if (parts.length > 3 && parts[2] === "tree" && parts[3]) {
      branch = parts[3];
      path = parts.slice(4).join("/");
    }

    return { owner, repo, branch, path };
  } catch {
    return null;
  }
}

async function fetchGitHubDirectory(
  owner: string,
  repo: string,
  branch: string,
  basePath: string
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function fetchDir(dirPath: string): Promise<void> {
    const apiUrl = dirPath
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`
      : `https://api.github.com/repos/${owner}/${repo}/contents?ref=${branch}`;

    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "dynamic-workers-playground"
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          `Repository or path not found: ${owner}/${repo}/${dirPath || "(root)"}`
        );
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const contents = (await response.json()) as GitHubContent | GitHubContent[];

    if (!Array.isArray(contents)) {
      if (contents.type === "file" && contents.download_url) {
        const fileResponse = await fetch(contents.download_url);
        if (fileResponse.ok) {
          const content = await fileResponse.text();
          const relativePath = basePath
            ? contents.path.replace(`${basePath}/`, "")
            : contents.path;
          files[relativePath] = content;
        }
      }
      return;
    }

    await Promise.all(
      contents.map(async (item) => {
        if (item.type === "file" && item.download_url) {
          const fileResponse = await fetch(item.download_url);
          if (fileResponse.ok) {
            const content = await fileResponse.text();
            const relativePath = basePath
              ? item.path.replace(`${basePath}/`, "")
              : item.path;
            files[relativePath] = content;
          }
          return;
        }

        if (item.type === "dir") {
          await fetchDir(item.path);
        }
      })
    );
  }

  await fetchDir(basePath);
  return files;
}

export async function handleGitHubImport(request: Request): Promise<Response> {
  try {
    const { url } = (await request.json()) as { url?: string };

    if (!url) {
      return Response.json({ error: "Missing GitHub URL." }, { status: 400 });
    }

    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      return Response.json(
        {
          error:
            "Invalid GitHub URL. Use a repository URL like https://github.com/owner/repo/tree/branch/path"
        },
        { status: 400 }
      );
    }

    const { owner, repo, branch, path } = parsed;
    const files = await fetchGitHubDirectory(owner, repo, branch, path);

    if (Object.keys(files).length === 0) {
      return Response.json(
        { error: "No files found at that GitHub location." },
        { status: 404 }
      );
    }

    return Response.json({
      files,
      source: {
        owner,
        repo,
        branch,
        path,
        url
      }
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to import GitHub files."
      },
      { status: 500 }
    );
  }
}
