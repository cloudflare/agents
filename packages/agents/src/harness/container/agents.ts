/**
 * What runs in the container, as typed presets: `claudeCode()`, `codex()`,
 * or `containerAgent()` for an image of your own.
 *
 * A preset is data: the adapter the daemon runs, how the container is
 * built, the environment the CLI sees, and the egress routes that carry
 * its credentials. Credentials (`apiKey`, `headers`) never go into the
 * container: the CLI calls a placeholder host, and `ContainerEgress`
 * forwards to `baseUrl` with the real credentials (see `./egress`).
 */

import type { EgressRoute } from "./egress";
import type { SetupStep } from "./managed-image";
import type { JsonValue } from "./protocol";

/**
 * Where a CLI's model requests go, and the credentials they carry. Added
 * outside the container, by `ContainerEgress`.
 *
 * - Straight to the provider: `{ apiKey }`.
 * - AI Gateway with Unified Billing: `{ baseUrl: `${gateway}/anthropic`,
 *   apiKey: gatewayToken }`; the gateway takes its token as the key.
 * - AI Gateway with BYOK: `{ baseUrl, headers: { "cf-aig-authorization":
 *   `Bearer ${gatewayToken}` } }`; the gateway holds the provider key.
 */
export type ProviderConnection = {
  /** Sent the way the provider expects: `x-api-key`, or `Authorization: Bearer`. */
  readonly apiKey?: string;
  /**
   * The provider's base URL, as its SDK names it (`ANTHROPIC_BASE_URL`,
   * `OPENAI_BASE_URL`). Default: the provider's own API.
   */
  readonly baseUrl?: string;
  /** More headers on every model request, such as gateway metadata. */
  readonly headers?: { readonly [name: string]: string };
};

/** How the container is built. */
export type ContainerImage =
  /**
   * `cloudflare/debian-trixie`, set up at runtime by the harness: the
   * steps run once and the result is snapshotted. The harness installs the
   * daemon.
   */
  | { readonly kind: "managed"; readonly setup: readonly SetupStep[] }
  /** An image you built, whose entrypoint runs the daemon itself. */
  | { readonly kind: "custom"; readonly image: string };

/** What runs in the container. Build one with a preset. */
export type ContainerAgent = {
  /** The daemon adapter: `claude-code`, `codex`, `echo`, or your own. */
  readonly adapter: string;
  readonly image: ContainerImage;
  /** Environment for the daemon and the CLI. Never put secrets here. */
  readonly env: { readonly [name: string]: string };
  /** Hosts the harness intercepts to add credentials. */
  readonly egress: readonly EgressRoute[];
  /** The model and adapter options new sessions start with. */
  readonly model?: string;
  readonly options?: JsonValue;
};

/** What the CLI sends instead of a key; egress replaces it. */
const PLACEHOLDER_KEY = "harness-egress";

const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "cf-aig-authorization"
];

function npmInstall(name: string, pkg: string): SetupStep {
  return {
    name: `install ${name}`,
    command: ["npm", "install", "--global", "--no-fund", "--no-audit", pkg]
  };
}

/** The egress route for one provider. */
function route(
  host: string,
  connection: ProviderConnection,
  provider: {
    readonly baseUrl: string;
    readonly keyHeader: (key: string) => { readonly [name: string]: string };
  }
): EgressRoute {
  return {
    host,
    upstream: connection.baseUrl ?? provider.baseUrl,
    headers: {
      ...(connection.apiKey === undefined
        ? {}
        : provider.keyHeader(connection.apiKey)),
      ...connection.headers
    },
    strip: CREDENTIAL_HEADERS
  };
}

/** `claudeCode()`'s options: its provider connection and settings. */
export type ClaudeCodeAgentOptions = ProviderConnection & {
  /** Default `claude-sonnet-4-5`. Change one session's with `setModel`. */
  readonly model?: string;
  /** The `@anthropic-ai/claude-code` version. Default `2.1.289`. */
  readonly version?: string;
  readonly appendSystemPrompt?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly maxTurns?: number;
  /**
   * More setup steps, run after the install and kept in the snapshot. Use
   * `user: "agent"` to install plugins, mods or settings in the agent's
   * home, which every session home starts from.
   */
  readonly setup?: readonly SetupStep[];
};

/**
 * Claude Code, installed at runtime on `cloudflare/debian-trixie`.
 *
 * @param options - Its provider connection (`apiKey`, `baseUrl`,
 *   `headers`) and settings.
 * @returns The agent, for `ContainerHarness`'s `agent`.
 *
 * @experimental The API may change before it stabilizes.
 */
export function claudeCode(options: ClaudeCodeAgentOptions): ContainerAgent {
  const host = "anthropic.harness.internal";
  return {
    adapter: "claude-code",
    image: {
      kind: "managed",
      setup: [
        npmInstall(
          "Claude Code",
          `@anthropic-ai/claude-code@${options.version ?? "2.1.289"}`
        ),
        ...(options.setup ?? [])
      ]
    },
    env: {
      ANTHROPIC_BASE_URL: `http://${host}`,
      ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
      DISABLE_AUTOUPDATER: "1"
    },
    egress: [
      route(host, options, {
        baseUrl: "https://api.anthropic.com",
        keyHeader: (key) => ({ "x-api-key": key })
      })
    ],
    model: options.model ?? "claude-sonnet-4-5",
    options: {
      ...(options.appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: options.appendSystemPrompt }),
      ...(options.allowedTools === undefined
        ? {}
        : { allowedTools: [...options.allowedTools] }),
      ...(options.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...options.disallowedTools] }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns })
    }
  };
}

/** `codex()`'s options: its provider connection and settings. */
export type CodexAgentOptions = ProviderConnection & {
  /** Default `gpt-5.1`. Change one session's with `setModel`. */
  readonly model?: string;
  /** The `@openai/codex` version. Default `0.157.0`. */
  readonly version?: string;
  /** Extra `-c key=value` config overrides. */
  readonly config?: readonly string[];
  /**
   * More setup steps, run after the install and kept in the snapshot. Use
   * `user: "agent"` to install plugins, mods or settings in the agent's
   * home, which every session home starts from.
   */
  readonly setup?: readonly SetupStep[];
};

/**
 * Codex, installed at runtime on `cloudflare/debian-trixie`.
 *
 * @param options - Its provider connection (`apiKey`, `baseUrl`,
 *   `headers`) and settings.
 * @returns The agent, for `ContainerHarness`'s `agent`.
 *
 * @experimental The API may change before it stabilizes.
 */
export function codex(options: CodexAgentOptions): ContainerAgent {
  const host = "openai.harness.internal";
  return {
    adapter: "codex",
    image: {
      kind: "managed",
      setup: [
        npmInstall("Codex", `@openai/codex@${options.version ?? "0.157.0"}`),
        ...(options.setup ?? [])
      ]
    },
    env: {
      OPENAI_BASE_URL: `http://${host}`,
      OPENAI_API_KEY: PLACEHOLDER_KEY
    },
    egress: [
      route(host, options, {
        baseUrl: "https://api.openai.com/v1",
        keyHeader: (key) => ({ authorization: `Bearer ${key}` })
      })
    ],
    model: options.model ?? "gpt-5.1",
    options: options.config === undefined ? {} : { config: [...options.config] }
  };
}

/** `containerAgent()`'s options. */
export type CustomAgentOptions = {
  /** Your image, such as `ctx.container.images.agent`. Its entrypoint runs the daemon. */
  readonly image: string;
  /** The adapter its daemon runs. */
  readonly adapter: string;
  readonly env?: { readonly [name: string]: string };
  readonly egress?: readonly EgressRoute[];
  readonly model?: string;
  readonly options?: JsonValue;
};

/**
 * An agent in an image you built, whose entrypoint serves the daemon
 * (`serveFromEnv` from `agents/harness/container/runtime`).
 *
 * @param options - The image, the adapter, and its environment.
 * @returns The agent, for `ContainerHarness`'s `agent`.
 *
 * @experimental The API may change before it stabilizes.
 */
export function containerAgent(options: CustomAgentOptions): ContainerAgent {
  return {
    adapter: options.adapter,
    image: { kind: "custom", image: options.image },
    env: options.env ?? {},
    egress: options.egress ?? [],
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.options === undefined ? {} : { options: options.options })
  };
}

/**
 * The echo adapter on `cloudflare/debian-trixie`: no CLI, no model, no
 * credentials. For smoke tests of the whole path.
 *
 * @returns The agent, for `ContainerHarness`'s `agent`.
 *
 * @experimental The API may change before it stabilizes.
 */
export function echoAgent(): ContainerAgent {
  return {
    adapter: "echo",
    image: { kind: "managed", setup: [] },
    env: {},
    egress: []
  };
}
