import {
  OpenApiConnector,
  type OpenApiRequestOptions
} from "@cloudflare/codemode";

const openapiSpec = {
  openapi: "3.1.0",
  info: { title: "Repository Metadata API", version: "1.0.0" },
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "get_repository",
        summary: "Get repository metadata."
      }
    },
    "/repos/{owner}/{repo}/releases": {
      get: {
        operationId: "list_releases",
        summary: "List repository releases."
      }
    }
  }
};

/**
 * Repository API connector — backed by an OpenAPI spec.
 *
 * Exposes repository metadata and release operations in the codemode
 * sandbox as `repoApi.search(query)` and `repoApi.request(options)`.
 */
export class RepoApiConnector extends OpenApiConnector<Env> {
  name() {
    return "repoApi";
  }

  protected override instructions() {
    return "Use for repository metadata and release information.";
  }

  protected spec() {
    return openapiSpec;
  }

  protected async request(input: OpenApiRequestOptions) {
    const p = input.params as { owner: string; repo: string };
    if (input.operationId === "get_repository") {
      return {
        fullName: `${p.owner}/${p.repo}`,
        stars: 1234,
        defaultBranch: "main",
        language: "TypeScript"
      };
    }
    return [
      { tag: "v0.12.4", name: "agents 0.12.4" },
      { tag: "@cloudflare/codemode@0.3.5", name: "codemode 0.3.5" }
    ];
  }
}
