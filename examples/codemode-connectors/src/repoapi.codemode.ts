import {
  OpenApiConnector,
  type OpenApiRequestOptions
} from "@cloudflare/codemode";

// A tiny OpenAPI document. The connector derives one typed tool per operation
// from this (host-side, zero prompt tokens), so the model calls
// `repoApi.get_repository({ owner, repo })` directly.
const openapiSpec = {
  openapi: "3.1.0",
  info: { title: "Repository Metadata API", version: "1.0.0" },
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "get_repository",
        summary: "Get repository metadata.",
        parameters: [
          {
            name: "owner",
            in: "path",
            required: true,
            schema: { type: "string" }
          },
          {
            name: "repo",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        ]
      }
    },
    "/repos/{owner}/{repo}/releases": {
      get: {
        operationId: "list_releases",
        summary: "List repository releases.",
        parameters: [
          {
            name: "owner",
            in: "path",
            required: true,
            schema: { type: "string" }
          },
          {
            name: "repo",
            in: "path",
            required: true,
            schema: { type: "string" }
          }
        ]
      }
    }
  }
};

/**
 * Repository API connector — backed by an OpenAPI spec.
 *
 * `OpenApiConnector` reads the spec and exposes each operation as a typed tool:
 * `repoApi.get_repository(...)`, `repoApi.list_releases(...)`. Path params are
 * substituted automatically; `request()` just performs the authenticated call.
 */
export class RepoApiConnector extends OpenApiConnector<Env> {
  name() {
    return "repoApi";
  }

  protected override instructions() {
    return "Repository metadata and releases. Call repoApi.get_repository({ owner, repo }) and repoApi.list_releases({ owner, repo }).";
  }

  protected spec() {
    return openapiSpec;
  }

  // Authenticated request. The derived tools hand us a path with params already
  // substituted; a real connector would prepend a base URL and attach
  // credentials. This demo returns canned data.
  protected async request(options: OpenApiRequestOptions) {
    if (options.path.endsWith("/releases")) {
      return [
        { tag: "v0.12.4", name: "agents 0.12.4" },
        { tag: "@cloudflare/codemode@0.3.5", name: "codemode 0.3.5" }
      ];
    }
    const fullName = options.path.replace("/repos/", "");
    return {
      fullName,
      stars: 1234,
      defaultBranch: "main",
      language: "TypeScript"
    };
  }
}
