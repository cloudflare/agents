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
 * The model reads the spec with `repoApi.spec()` and makes authenticated
 * calls with `repoApi.request({ path, method, params, body })`.
 */
export class RepoApiConnector extends OpenApiConnector<Env> {
  name() {
    return "repoApi";
  }

  protected override instructions() {
    return "Use for repository metadata and release information. Read repoApi.spec() and call repoApi.request(...).";
  }

  protected spec() {
    return openapiSpec;
  }

  // Authenticated request. A real connector would build a URL from `path` +
  // `params` and attach credentials; this demo returns canned data.
  protected async request(options: OpenApiRequestOptions) {
    const p = (options.params ?? {}) as { owner?: string; repo?: string };
    if (options.path === "/repos/{owner}/{repo}") {
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
