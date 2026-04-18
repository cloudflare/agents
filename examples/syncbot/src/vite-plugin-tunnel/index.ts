// oxlint-disable typescript/no-explicit-any
/**
 * @fileoverview Cloudflare Tunnel Vite Plugin
 *
 * A self-contained Vite plugin that automatically creates and manages
 * Cloudflare tunnels for local development, providing instant HTTPS access
 * to your local dev server from anywhere on the internet.
 *
 * @author Cloudflare Tunnel Vite Plugin Contributors
 * @version 1.0.0
 * @license MIT
 */

import type { Plugin, ViteDevServer } from "vite";
import { bin, install } from "cloudflared";
import fs from "node:fs/promises";
import { spawn, exec } from "node:child_process";
import { z } from "zod";
// import { config as dotEnvConfig } from "dotenv";

// import { inspect } from "util";
// // log infinite depth objects using node settings
// inspect.defaultOptions.depth = null;

const INFO_LOG_REGEX = /^.*Z INF .*/;

// Zod schemas for Cloudflare API responses
const CloudflareErrorSchema = z.object({
  code: z.number(),
  message: z.string()
});

const CloudflareApiResponseSchema = z.object({
  success: z.boolean(),
  errors: z.array(CloudflareErrorSchema).optional(),
  messages: z.array(z.string()).optional(),
  result: z.unknown()
});

const AccountSchema = z.object({
  id: z.string(),
  name: z.string()
});

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string()
});

const TunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  account_tag: z.string(),
  created_at: z.string(),
  connections: z.array(z.unknown()).optional()
});

const DNSRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  comment: z.string().nullish()
});

// Type definitions (exported for potential external use)
export type CloudflareApiResponse<T = unknown> = z.infer<
  typeof CloudflareApiResponseSchema
> & {
  result: T;
};
export type Account = z.infer<typeof AccountSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Tunnel = z.infer<typeof TunnelSchema>;
export type DNSRecord = z.infer<typeof DNSRecordSchema>;

/**
 * Base configuration options shared between named and quick tunnel modes
 */
interface BaseTunnelOptions {
  /**
   * Local port your dev server listens on
   * If not specified, will automatically use Vite's configured port
   * @default undefined (auto-detect from Vite config)
   */
  port?: number;

  /**
   * Path to write cloudflared logs to a file
   * Useful for debugging tunnel issues
   */
  logFile?: string;

  /**
   * Log level for cloudflared process
   * @default undefined (uses cloudflared default)
   */
  logLevel?: "debug" | "info" | "warn" | "error" | "fatal";

  /**
   * Enable additional verbose logging for easier debugging.
   * When true, the plugin will output extra information prefixed with
   * `[cloudflare-tunnel:debug]`.
   * @default false
   */
  debug?: boolean;

  /**
   * Enable or disable the tunnel plugin. When set to `false` the plugin is
   * completely disabled — cloudflared will NOT be downloaded or started but
   * the virtual module is still available (it returns an empty string).
   * @default true
   */
  enabled?: boolean;
}

/**
 * Configuration options for named tunnel mode (requires hostname and API token)
 */
interface NamedTunnelOptions extends BaseTunnelOptions {
  /**
   * Public hostname for the tunnel (e.g., "dev.example.com")
   * Must be a domain in your Cloudflare account
   */
  hostname: string;

  /**
   * Cloudflare API token with required permissions:
   * - Zone:Zone:Read
   * - Zone:DNS:Edit
   * - Account:Cloudflare Tunnel:Edit
   *
   * Fallback priority:
   * 1. Provided apiToken option
   * 2. CLOUDFLARE_API_KEY environment variable
   */
  apiToken?: string;

  /**
   * Cloudflare account ID
   * If omitted, uses the first account associated with the API token
   */
  accountId?: string;

  /**
   * Cloudflare zone ID
   * If omitted, automatically resolved from the hostname
   */
  zoneId?: string;

  /**
   * Name for the tunnel in your Cloudflare dashboard
   * Must contain only letters, numbers, and hyphens. Cannot start or end with a hyphen.
   * @default "vite-tunnel"
   */
  tunnelName?: string;

  /**
   * Wildcard DNS domain to ensure exists (e.g., "*.example.com").
   * When provided the plugin will ensure both A and AAAA records exist.
   */
  dns?: string;

  /**
   * Wildcard SSL domain to ensure exists (e.g., "*.example.com").
   * When provided the plugin will request/ensure a wildcard edge certificate.
   * If omitted the plugin will attempt to detect an existing wildcard certificate
   * or Total TLS; otherwise it will request a regular certificate for the provided hostname.
   */
  ssl?: string;

  /**
   * Cleanup configuration for managing orphaned resources
   */
  cleanup?: {
    /**
     * Whether to automatically clean up orphaned DNS records on startup
     * @default true
     */
    autoCleanup?: boolean;

    /**
     * Array of tunnel names to preserve during cleanup (in addition to current tunnel)
     * @default []
     */
    preserveTunnels?: string[];
  };
}

/**
 * Configuration options for quick tunnel mode (no hostname required, generates random URL)
 */
interface QuickTunnelOptions extends BaseTunnelOptions {
  // No additional options beyond base options
}

/**
 * Configuration options for the Cloudflare Tunnel Vite plugin
 *
 * Two modes are supported:
 * - Named tunnel mode: Provide `hostname` for a persistent tunnel with custom domain
 * - Quick tunnel mode: Omit `hostname` for a temporary tunnel with random trycloudflare.com URL
 */
export type CloudflareTunnelOptions = NamedTunnelOptions | QuickTunnelOptions;

/**
 * Creates a Vite plugin that automatically sets up Cloudflare tunnels for local development
 *
 * @param options - Configuration options for the tunnel
 * @returns Vite plugin instance
 *
 * @example
 * ```typescript
 * import { defineConfig } from 'vite';
 * import cloudflareTunnel from 'vite-plugin-cloudflare-tunnel';
 *
 * // Named tunnel mode (custom domain)
 * export default defineConfig({
 *   plugins: [
 *     cloudflareTunnel({
 *       hostname: 'dev.example.com',
 *       logLevel: 'info'
 *     })
 *   ]
 * });
 *
 * // Quick tunnel mode (random trycloudflare.com URL)
 * export default defineConfig({
 *   plugins: [
 *     cloudflareTunnel({
 *       logLevel: 'info'
 *     })
 *   ]
 * });
 * ```
 */
function cloudflareTunnel(options: CloudflareTunnelOptions = {}): Plugin {
  // ---------------------------------------------------------------------
  // Early exit when plugin is explicitly disabled via the `enabled` option.
  // We still provide the virtual module so application code can import it
  // safely, however it will always return an empty string.
  // ---------------------------------------------------------------------
  const { enabled = true } = options as { enabled?: boolean };
  if (enabled === false) {
    const VIRTUAL_MODULE_ID_STUB = "virtual:vite-plugin-cloudflare-tunnel";
    return {
      name: "vite-plugin-cloudflare-tunnel",
      enforce: "pre",

      // Skip all config modifications when disabled
      config() {
        /* no-op */
      },
      configureServer() {
        /* no-op */
      },

      resolveId(id) {
        if (id === VIRTUAL_MODULE_ID_STUB) {
          return "\0" + VIRTUAL_MODULE_ID_STUB;
        }
        return;
      },

      load(id) {
        if (id === "\0" + VIRTUAL_MODULE_ID_STUB) {
          return 'export function getTunnelUrl() { return ""; }';
        }
        return;
      }
    } as Plugin;
  }
  // ---------------------------------------------------------------------
  // In dev/HMR the plugin may be instantiated multiple times without the
  // Node.js process exiting.  We keep a reference to the current tunnel
  // child-process on the global object so that we can re-use or clean it
  // up before starting a new one.  This prevents duplicate tunnels and
  // "listen called twice" crashes when Vite restarts.
  // ---------------------------------------------------------------------

  const GLOBAL_STATE = Symbol.for("vite-plugin-cloudflare-tunnel.state");

  type GlobalState = {
    child?: ReturnType<typeof spawn>;
    exitHandlersRegistered?: boolean;
    configHash?: string;
    shuttingDown?: boolean;
    tunnelUrl: Promise<string> | undefined;
    // Allow dynamic keys for SSL certificate tracking
    [key: string]: any;
  };

  const globalState: GlobalState = (globalThis as any)[GLOBAL_STATE] ?? {};
  // Ensure the symbol is always present so future plugin instances see it
  (globalThis as any)[GLOBAL_STATE] = globalState;

  // Local reference, kept in sync with the global state
  let child: ReturnType<typeof spawn> | undefined = globalState.child;

  // ---------------------------------------------------------------------
  // Virtual module to expose the tunnel URL at dev time
  // ---------------------------------------------------------------------
  const VIRTUAL_MODULE_ID = "virtual:vite-plugin-cloudflare-tunnel";
  // const RESOLVED_VIRTUAL_MODULE_ID = '\0' + VIRTUAL_MODULE_ID;
  let tunnelUrl = "";

  // ---------------------------------------------------------------------
  // Load env vars & extract/validate options (this block was accidentally
  // removed in a previous edit – restoring it here).
  // ---------------------------------------------------------------------

  // Determine tunnel mode and validate options
  const isQuickMode = !("hostname" in options);

  // Validate that quick mode options don't include named-mode-only options
  if (isQuickMode) {
    const namedModeOptions = [
      "apiToken",
      "accountId",
      "zoneId",
      "tunnelName",
      "dns",
      "ssl",
      "cleanup"
    ];
    const invalidOptions = namedModeOptions.filter((opt) => opt in options);
    if (invalidOptions.length > 0) {
      throw new Error(
        `[cloudflare-tunnel] The following options are only supported in named tunnel mode (when hostname is provided): ${invalidOptions.join(", ")}. ` +
          `Either provide a hostname for named tunnel mode, or remove these options for quick tunnel mode.`
      );
    }
  }

  // Extract options based on mode
  let providedApiToken: string | undefined;
  let hostname: string | undefined;
  let tunnelName: string;
  let forcedAccount: string | undefined;
  let forcedZone: string | undefined;
  let dnsOption: string | undefined;
  let sslOption: string | undefined;
  let cleanupConfig: any;

  if (isQuickMode) {
    // Quick mode - only base options
    tunnelName = "quick-tunnel"; // Default for quick mode
    cleanupConfig = {};
  } else {
    // Named mode - extract all options
    const namedOptions = options as NamedTunnelOptions;
    providedApiToken = namedOptions.apiToken;
    hostname = namedOptions.hostname;
    forcedAccount = namedOptions.accountId;
    forcedZone = namedOptions.zoneId;
    tunnelName = namedOptions.tunnelName || "vite-tunnel";
    dnsOption = namedOptions.dns;
    sslOption = namedOptions.ssl;
    cleanupConfig = namedOptions.cleanup || {};
  }

  // Extract common options
  const { port: userProvidedPort, logFile, logLevel, debug = false } = options;

  // Internal debug logger – prints only when `debug` flag enabled
  const debugLog = (...args: unknown[]) => {
    if (debug) {
      console.log("[cloudflare-tunnel:debug]", ...args);
    }
  };

  // Basic input validation
  if (!isQuickMode && (!hostname || typeof hostname !== "string")) {
    throw new Error(
      "[cloudflare-tunnel] hostname is required and must be a valid string in named tunnel mode"
    );
  }
  if (hostname) {
    tunnelUrl = `https://${hostname}`;
  }

  // Validate tunnel name contains only DNS-safe characters
  if (
    tunnelName &&
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tunnelName)
  ) {
    throw new Error(
      "[cloudflare-tunnel] tunnelName must contain only letters, numbers, and hyphens. " +
        "It cannot start or end with a hyphen. This ensures compatibility with DNS records and SSL certificates."
    );
  }

  if (
    userProvidedPort &&
    (typeof userProvidedPort !== "number" ||
      userProvidedPort < 1 ||
      userProvidedPort > 65535)
  ) {
    throw new Error(
      "[cloudflare-tunnel] port must be a valid number between 1 and 65535"
    );
  }

  if (
    logLevel &&
    !["debug", "info", "warn", "error", "fatal"].includes(logLevel)
  ) {
    throw new Error(
      "[cloudflare-tunnel] logLevel must be one of: debug, info, warn, error, fatal"
    );
  }

  // Determine effective log level for cloudflared: explicit option > debug flag > default warn
  const effectiveLogLevel: "debug" | "info" | "warn" | "error" | "fatal" =
    (logLevel as any) ?? (debug ? "info" : "warn");
  debugLog("Effective cloudflared log level:", effectiveLogLevel);

  if (dnsOption) {
    const isDnsWildcard = dnsOption.startsWith("*.");
    if (!isDnsWildcard && dnsOption !== hostname) {
      throw new Error(
        "[cloudflare-tunnel] dns option must either be a wildcard (e.g., '*.example.com') or exactly match the hostname"
      );
    }
  }

  if (sslOption) {
    const isSslWildcard = sslOption.startsWith("*.");
    if (!isSslWildcard && sslOption !== hostname) {
      throw new Error(
        "[cloudflare-tunnel] ssl option must either be a wildcard (e.g., '*.example.com') or exactly match the hostname"
      );
    }
  }

  // ---------------------------------------------------------------------
  // Helper to call Cloudflare API (also restored).
  // ---------------------------------------------------------------------

  /**
   * Track SSL certificates created by this plugin
   * Since SSL certificates don't support custom metadata, we track them by hostname patterns
   */
  const trackSslCertificate = (
    certificateId: string,
    hosts: string[],
    tunnelName: string,
    timestamp: string = new Date().toISOString()
  ) => {
    // Store certificate tracking info in global state for cleanup later
    const trackingKey = `ssl-cert-${certificateId}`;
    globalState[trackingKey] = {
      id: certificateId,
      hosts,
      tunnelName,
      timestamp,
      pluginVersion: "1.0.0"
    };
    debugLog(
      `Tracking SSL certificate: ${certificateId} for hosts: ${hosts.join(", ")}`
    );
  };

  /**
   * Find mismatched SSL certificates from the current tunnel that don't cover current hostname
   */
  const findMismatchedSslCertificates = async (
    apiToken: string,
    zoneId: string,
    currentTunnelName: string,
    currentHostname: string
  ): Promise<any[]> => {
    try {
      const certPacks: any = await cf(
        apiToken,
        "GET",
        `/zones/${zoneId}/ssl/certificate_packs?status=all`,
        undefined,
        z.any()
      );
      const allCerts: any[] = Array.isArray(certPacks)
        ? certPacks
        : certPacks.result || [];

      // Find certificates created by our plugin for the current tunnel
      const currentTunnelCerts = allCerts.filter((cert) => {
        const certHosts = cert.hostnames || cert.hosts || [];

        // Look for our tag hostname pattern with current tunnel name
        return certHosts.some((host: string) =>
          host.startsWith(`cf-tunnel-plugin-${currentTunnelName}--`)
        );
      });

      debugLog(
        `Found ${currentTunnelCerts.length} SSL certificates for current tunnel: ${currentTunnelName}`
      );

      // From current tunnel certificates, find ones that don't cover current hostname
      const mismatchedCerts = currentTunnelCerts.filter((cert) => {
        const certHosts = cert.hostnames || cert.hosts || [];

        // Check if certificate covers current hostname
        const coversCurrentHostname = certHosts.some((host: string) => {
          // Skip tag hostnames when checking coverage
          if (host.startsWith("cf-tunnel-plugin-")) return false;

          // Check exact match or wildcard match
          return (
            host === currentHostname ||
            (host.startsWith("*.") && currentHostname.endsWith(host.slice(1)))
          );
        });

        // If certificate doesn't cover current hostname, it's mismatched
        return !coversCurrentHostname;
      });

      debugLog(
        `Found ${mismatchedCerts.length} mismatched SSL certificates`,
        mismatchedCerts.map((c) => ({
          id: c.id,
          hosts: c.hostnames || c.hosts,
          currentHostname
        }))
      );

      return mismatchedCerts;
    } catch (error) {
      console.error(
        `[cloudflare-tunnel] ❌ SSL certificate listing failed: ${(error as Error).message}`
      );
      return [];
    }
  };

  /**
   * Cleanup mismatched DNS records from the current tunnel that don't match current configuration
   * @param apiToken Cloudflare API token
   * @param zoneId Zone ID to clean up
   * @param currentTunnelName Current tunnel name
   * @param currentHostname Current hostname configuration
   * @param tunnelId Current tunnel ID for CNAME content
   */
  const cleanupMismatchedDnsRecords = async (
    apiToken: string,
    zoneId: string,
    dnsComment: string,
    currentHostname: string,
    tunnelId: string
  ): Promise<{ found: DNSRecord[]; deleted: DNSRecord[] }> => {
    try {
      // Find DNS records created by our plugin for the current tunnel
      const pluginDnsRecords = await cf(
        apiToken,
        "GET",
        `/zones/${zoneId}/dns_records?comment=${dnsComment}&match=all`,
        undefined,
        z.array(DNSRecordSchema)
      );

      debugLog(
        `Found ${pluginDnsRecords.length} DNS records for current tunnel: ${dnsComment}`
      );

      // Identify mismatched records (don't match current configuration)
      const expectedCnameContent = `${tunnelId}.cfargotunnel.com`;
      const mismatchedRecords = pluginDnsRecords.filter((record) => {
        // Skip records that match current configuration
        if (
          record.name === currentHostname &&
          record.content === expectedCnameContent
        ) {
          return false; // This record matches current config, keep it
        }

        // Check if this is a wildcard DNS record that's still valid
        if (
          dnsOption &&
          record.name === dnsOption &&
          record.content === expectedCnameContent
        ) {
          return false; // This wildcard record matches current config, keep it
        }

        return true; // This record doesn't match current config, mark for cleanup
      });

      debugLog(
        `Found ${mismatchedRecords.length} mismatched DNS records`,
        mismatchedRecords.map((r) => ({
          name: r.name,
          content: r.content,
          expected: expectedCnameContent,
          comment: r.comment
        }))
      );

      const deletedRecords: DNSRecord[] = [];

      if (mismatchedRecords.length > 0) {
        console.log(
          `[cloudflare-tunnel] 🧹 Cleaning up ${mismatchedRecords.length} mismatched DNS records from tunnel '${dnsComment}'...`
        );

        for (const record of mismatchedRecords) {
          try {
            await cf(
              apiToken,
              "DELETE",
              `/zones/${zoneId}/dns_records/${record.id}`
            );
            deletedRecords.push(record);
            console.log(
              `[cloudflare-tunnel] ✅ Deleted mismatched DNS record: ${record.name} → ${record.content}`
            );
          } catch (error) {
            console.error(
              `[cloudflare-tunnel] ❌ Failed to delete DNS record ${record.name}: ${(error as Error).message}`
            );
          }
        }
      }

      return {
        found: mismatchedRecords,
        deleted: deletedRecords
      };
    } catch (error) {
      console.error(
        `[cloudflare-tunnel] ❌ DNS cleanup failed: ${(error as Error).message}`
      );
      return { found: [], deleted: [] };
    }
  };

  const cf = async <T>(
    apiToken: string,
    method: string,
    url: string,
    body?: unknown,
    resultSchema?: z.ZodSchema<T>
  ): Promise<T> => {
    try {
      debugLog("→ CF API", method, url, body ? { body } : "");

      const response = await fetch(
        `https://api.cloudflare.com/client/v4${url}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
            "User-Agent": "vite-plugin-cloudflare-tunnel/1.0.0"
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `[cloudflare-tunnel] API request failed: ${response.status} ${response.statusText}. Response: ${errorText}`
        );
      }

      const rawData = await response.json();
      debugLog("← CF API response", rawData);
      const apiResponse = CloudflareApiResponseSchema.parse(rawData);

      if (!apiResponse.success) {
        const errorMsg =
          apiResponse.errors
            ?.map((e) => e.message || `Error ${e.code}`)
            .join(", ") || "Unknown API error";
        throw new Error(
          `[cloudflare-tunnel] Cloudflare API error: ${errorMsg}`
        );
      }

      if (resultSchema) {
        const parsed = resultSchema.parse(apiResponse.result);
        debugLog("← Parsed result", parsed);
        return parsed;
      }

      debugLog("← Result (untyped)", apiResponse.result);
      return apiResponse.result as T;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("[cloudflare-tunnel]")) {
          throw error;
        }
        throw new Error(
          `[cloudflare-tunnel] API request failed: ${error.message}`
        );
      }
      throw new Error("[cloudflare-tunnel] Unknown API error occurred");
    }
  };

  // -------------------------------------------------------------------
  // Helper: Retry an async operation with exponential back-off.
  // Logs each error message and retries up to `maxRetries` times.
  // -------------------------------------------------------------------
  const retryWithBackoff = async <T>(
    fn: () => Promise<T>,
    maxRetries = 5,
    initialDelayMs = 1000
  ): Promise<T> => {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (error) {
        attempt += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt > maxRetries) {
          console.error(
            `[cloudflare-tunnel] ❌ Edge certificate request failed after ${maxRetries} retries: ${message}`
          );
          throw error;
        }
        const delay = initialDelayMs * 2 ** (attempt - 1);
        console.error(
          `[cloudflare-tunnel] ⚠️  Edge certificate request failed (attempt ${attempt}/${maxRetries}): ${message}`
        );
        console.error(`[cloudflare-tunnel] ⏳ Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  // Helper function to spawn quick tunnel and extract URL
  const spawnQuickTunnel = async (
    localTarget: string
  ): Promise<{ child: ReturnType<typeof spawn>; url: string }> => {
    const cloudflaredArgs = ["tunnel"];

    // Add logging options
    cloudflaredArgs.push("--loglevel", "info"); // we must use info level to get the tunnel URL
    if (logFile) {
      cloudflaredArgs.push("--logfile", logFile);
    }

    // Add the URL target
    cloudflaredArgs.push("--url", localTarget);

    debugLog("Spawning quick tunnel:", bin, cloudflaredArgs);
    const child = spawn(bin, cloudflaredArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      shell: process.platform === "win32"
    });

    console.log(
      `[cloudflare-tunnel] Quick tunnel process spawned with PID: ${child.pid}`
    );

    // Wait for the tunnel URL to be output
    return new Promise((resolve, reject) => {
      let urlFound = false;
      const timeout = setTimeout(() => {
        if (!urlFound) {
          reject(
            new Error("Quick tunnel URL not found in output within 30 seconds")
          );
        }
      }, 30000);

      child.stdout?.on("data", (data) => {
        const output = data.toString();
        if (!globalState.shuttingDown || debug) {
          if (effectiveLogLevel === "debug" || effectiveLogLevel === "info") {
            console.log(`[cloudflared stdout] ${output.trim()}`);
          } else {
            // filter out outputs like 2025-07-30T09:29:37Z INF ... using regex
            for (const line of output.split("\n")) {
              if (!INFO_LOG_REGEX.test(line)) {
                console.log(`[cloudflared stdout] ${line.trim()}`);
              }
            }
          }
        }
      });

      child.stderr?.on("data", (data) => {
        const error = data.toString().trim();

        // Look for the tunnel URL in various formats
        const urlMatch = error.match(
          /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/
        );
        if (urlMatch && !urlFound) {
          urlFound = true;
          clearTimeout(timeout);
          resolve({ child, url: urlMatch[0] });
        }

        // Filter out noisy ICMP errors
        if (
          error.includes("Failed to parse ICMP reply") ||
          error.includes("unknow ip version 0")
        ) {
          if (logLevel === "debug") {
            console.log(`[cloudflared debug] ${error}`);
          }
          return;
        }

        if (!globalState.shuttingDown || debug) {
          if (effectiveLogLevel === "debug" || effectiveLogLevel === "info") {
            console.error(`[cloudflared stderr] ${error}`);
          } else {
            // filter out outputs like 2025-07-30T09:29:37Z INF ... using regex
            for (const line of error.split("\n")) {
              if (!INFO_LOG_REGEX.test(line)) {
                console.error(`[cloudflared stderr] ${line.trim()}`);
              }
            }
          }
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(
          new Error(`Failed to start quick tunnel process: ${error.message}`)
        );
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        if (!urlFound) {
          reject(
            new Error(
              `Quick tunnel process exited before URL was found (code: ${code}, signal: ${signal})`
            )
          );
        }
      });
    });
  };

  // Cleanup function to ensure cloudflared is always terminated
  const killCloudflared = (signal: NodeJS.Signals = "SIGTERM") => {
    if (!child || child.killed) return;

    // Set shutdown flag to silence logs unless debug is enabled
    globalState.shuttingDown = true;
    globalState.tunnelUrl = undefined;

    try {
      console.log(
        `[cloudflare-tunnel] 🛑 Terminating cloudflared process (PID: ${child.pid}) with ${signal}...`
      );
      const killed = child.kill(signal);

      // On Windows some signals (e.g. SIGTERM) may be no-ops for non-Node processes. Fallback to taskkill if needed.
      if (!killed && process.platform === "win32") {
        exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      }

      // Force kill after timeout if graceful termination fails
      if (signal === "SIGTERM") {
        setTimeout(() => {
          if (child && !child.killed) {
            console.log(
              "[cloudflare-tunnel] 🛑 Force killing cloudflared process..."
            );
            if (process.platform === "win32") {
              exec(`taskkill /pid ${child.pid} /T /F`, () => {});
            } else {
              child.kill("SIGKILL");
            }
          }
        }, 2000);
      }
    } catch (error) {
      // Process might already be dead, ignore errors
      console.log(
        `[cloudflare-tunnel] Note: Error killing cloudflared: ${error}`
      );
    }
  };

  // Track if exit handlers are already registered *across all instances*
  let exitHandlersRegistered = globalState.exitHandlersRegistered ?? false;

  const registerExitHandler = () => {
    if (exitHandlersRegistered) return;
    exitHandlersRegistered = true;
    globalState.exitHandlersRegistered = true;

    const cleanup = () => killCloudflared("SIGTERM");

    // Handle graceful shutdowns
    process.once("exit", cleanup);
    process.once("beforeExit", cleanup);

    // Handle signals that can terminate the process
    ["SIGINT", "SIGTERM", "SIGQUIT", "SIGHUP"].forEach((signal) => {
      process.once(signal as NodeJS.Signals, () => {
        killCloudflared(signal as NodeJS.Signals);

        // Re-emit the signal if the current platform supports it, otherwise exit gracefully.
        try {
          process.kill(process.pid, signal as NodeJS.Signals);
        } catch {
          // Unsupported signal on this platform (e.g. Windows)
          process.exit(0);
        }
      });
    });

    // Log the error but don't re-throw – re-throwing would bring down the
    // whole dev server which is particularly painful when Vite restarts the
    // process due to HMR / config changes.
    process.once("uncaughtException", (error) => {
      console.error(
        "[cloudflare-tunnel] Uncaught exception, cleaning up cloudflared...",
        error
      );
      killCloudflared("SIGTERM");
    });

    process.once("unhandledRejection", (reason) => {
      console.error(
        "[cloudflare-tunnel] Unhandled rejection, cleaning up cloudflared...",
        reason
      );
      killCloudflared("SIGTERM");
    });
  };

  const configureServer = async (server: ViteDevServer) => {
    // Helper to generate consistent metadata comment for DNS records
    const generateDnsComment = () => {
      return `vite-plugin-cloudflare-tunnel:${tunnelName}`;
    };

    try {
      // ------------------------------------------------------------
      // Decide whether we need to restart cloudflared or keep the existing
      // one running. We generate a hash of the **effective** runtime config
      // (hostname, port, tunnel name, dns & ssl options) and compare it
      // against what was used to start the currently running tunnel.
      // ------------------------------------------------------------

      const { host: serverHost, port: detectedPort } = normalizeAddress(
        server.httpServer?.address()
      );
      const port =
        userProvidedPort || detectedPort || server.config.server.port || 5173;
      const newConfigHash = JSON.stringify({
        isQuickMode,
        hostname,
        port,
        tunnelName,
        dnsOption,
        sslOption
      });

      if (
        globalState.child &&
        !globalState.child.killed &&
        globalState.configHash === newConfigHash
      ) {
        tunnelUrl = (await globalState.tunnelUrl) ?? "";
        console.log(
          "[cloudflare-tunnel] Config unchanged – re-using existing tunnel"
        );
        // Reset shutdown flag in case it was set from a previous shutdown
        globalState.shuttingDown = false;
        registerExitHandler();
        return; // Nothing else to do – keep using current tunnel
      }

      // Config changed OR no tunnel running – shut down old process if any
      if (globalState.child && !globalState.child.killed) {
        console.log(
          "[cloudflare-tunnel] Config changed – terminating previous tunnel..."
        );
        try {
          globalState.child.kill("SIGTERM");
        } catch (_) {
          /* ignore */
        }
      }

      delete globalState.child;
      delete globalState.configHash;
      // Reset shutdown flag for the new tunnel
      globalState.shuttingDown = false;

      // Handle quick tunnel mode
      if (isQuickMode) {
        console.log("[cloudflare-tunnel] Starting quick tunnel mode...");
        debugLog("Quick tunnel mode - no API token or hostname required");

        // 1. Ensure the cloudflared binary exists
        await ensureCloudflaredBinary(bin);

        const localTarget = getLocalTarget(serverHost, port);
        debugLog("← Quick tunnel connecting to local target", localTarget);

        try {
          const { child: quickChild, url } =
            await spawnQuickTunnel(localTarget);
          tunnelUrl = url;
          child = quickChild;

          // Expose to future plugin instances
          globalState.child = child;
          globalState.configHash = newConfigHash;

          // Register cleanup handlers
          registerExitHandler();

          console.log(`🌐  Quick tunnel ready at: ${url}`);

          // Handle port conflicts for quick tunnels
          server.httpServer?.on("listening", async () => {
            try {
              const { host: actualServerHost, port: actualPort } =
                normalizeAddress(server.httpServer?.address());

              if (actualPort !== port) {
                console.log(
                  `[cloudflare-tunnel] ⚠️  Port conflict detected - Vite is using port ${actualPort} instead of ${port}`
                );
                console.log(
                  `[cloudflare-tunnel] 🔄 Quick tunnel needs to be restarted for new port...`
                );

                // Kill the current quick tunnel
                killCloudflared("SIGTERM");

                // Wait a moment for cleanup
                await new Promise((resolve) => setTimeout(resolve, 1000));

                // Start a new quick tunnel with the correct port

                const newLocalTarget = getLocalTarget(
                  actualServerHost,
                  actualPort ?? port
                );

                const { child: newChild, url: newUrl } =
                  await spawnQuickTunnel(newLocalTarget);
                tunnelUrl = newUrl;
                child = newChild;
                globalState.child = child;

                console.log(
                  `🌐  Quick tunnel updated for port ${actualPort}: ${newUrl}`
                );

                // Update the global config hash to reflect the new port
                const updatedConfigHash = JSON.stringify({
                  isQuickMode,
                  hostname,
                  port: actualPort,
                  tunnelName,
                  dnsOption,
                  sslOption
                });
                globalState.configHash = updatedConfigHash;
              }
            } catch (error) {
              console.error(
                `[cloudflare-tunnel] ❌ Failed to update quick tunnel for port change: ${(error as Error).message}`
              );
            }
          });

          // Stop the tunnel when Vite shuts down
          server.httpServer?.once("close", () => {
            killCloudflared("SIGTERM");
          });

          return; // Exit early for quick mode
        } catch (error) {
          console.error(
            `[cloudflare-tunnel] ❌ Quick tunnel setup failed: ${(error as Error).message}`
          );
          throw error;
        }
      }

      // Named tunnel mode logic starts here
      console.log("[cloudflare-tunnel] Starting named tunnel mode...");

      // Resolve API token with fallback priority:
      // 1. Provided apiToken option
      // 2. CLOUDFLARE_API_KEY environment variable
      const apiToken = providedApiToken || process.env.CLOUDFLARE_API_KEY;

      if (!apiToken) {
        throw new Error(
          "[cloudflare-tunnel] API token is required. " +
            "Provide it via 'apiToken' option or set the CLOUDFLARE_API_KEY environment variable. " +
            "Get your token at: https://dash.cloudflare.com/profile/api-tokens"
        );
      }

      // 'port' already computed above
      console.log(
        `[cloudflare-tunnel] Using port ${port}${userProvidedPort === port ? " (user-provided)" : " (from Vite config)"}`
      );

      // 1. Ensure the cloudflared binary exists
      await ensureCloudflaredBinary(bin);

      // 2. Figure out account & zone
      const accounts = await cf(
        apiToken,
        "GET",
        "/accounts",
        undefined,
        z.array(AccountSchema)
      );
      const accountId = forcedAccount || accounts[0]?.id;
      if (!accountId)
        throw new Error("Unable to determine Cloudflare account ID");

      const apexDomain = hostname!.split(".").slice(-2).join(".");
      const parentDomain = hostname!.split(".").slice(1).join(".");
      debugLog("← Apex domain", apexDomain);
      debugLog("← Parent domain", parentDomain);
      let zoneId: string | undefined = forcedZone;
      if (!zoneId) {
        let zones: Zone[] = [];
        try {
          zones = await cf(
            apiToken,
            "GET",
            `/zones?name=${parentDomain}`,
            undefined,
            z.array(ZoneSchema)
          );
        } catch (error) {
          debugLog("← Error fetching zone for parent domain", error);
        }
        if (zones.length === 0) {
          zones = await cf(
            apiToken,
            "GET",
            `/zones?name=${apexDomain}`,
            undefined,
            z.array(ZoneSchema)
          );
        }
        zoneId = zones[0]?.id;
      }
      if (!zoneId)
        throw new Error(`Zone ${apexDomain} not found in account ${accountId}`);

      // Extract cleanup configuration for later use
      const { autoCleanup = true } = cleanupConfig;

      // 3. Get or create the tunnel
      const tunnels = await cf(
        apiToken,
        "GET",
        `/accounts/${accountId}/cfd_tunnel?name=${tunnelName}`,
        undefined,
        z.array(TunnelSchema)
      );
      let tunnel = tunnels[0];

      if (!tunnel) {
        console.log(`[cloudflare-tunnel] Creating tunnel '${tunnelName}'...`);
        tunnel = await cf(
          apiToken,
          "POST",
          `/accounts/${accountId}/cfd_tunnel`,
          {
            name: tunnelName,
            config_src: "cloudflare"
          },
          TunnelSchema
        );
      }
      const tunnelId = tunnel.id as string;
      // 3.5. Cleanup mismatched resources from current tunnel if configured
      if (autoCleanup) {
        console.log(
          `[cloudflare-tunnel] 🧹 Running resource cleanup for tunnel '${tunnelName}'...`
        );

        // Cleanup DNS records that don't match current configuration
        const dnsCleanup = await cleanupMismatchedDnsRecords(
          apiToken,
          zoneId,
          generateDnsComment(),
          hostname!,
          tunnelId
        );
        if (dnsCleanup.found.length > 0) {
          console.log(
            `[cloudflare-tunnel] 📊 DNS cleanup: ${dnsCleanup.found.length} mismatched, ${dnsCleanup.deleted.length} deleted`
          );
        }

        // Check for mismatched SSL certificates
        const mismatchedSslCerts = await findMismatchedSslCertificates(
          apiToken,
          zoneId,
          tunnelName,
          hostname!
        );
        if (mismatchedSslCerts.length > 0) {
          // Delete the mismatched SSL certificates
          for (const cert of mismatchedSslCerts) {
            await cf(
              apiToken,
              "DELETE",
              `/zones/${zoneId}/ssl/certificate_packs/${cert.id}`
            );
          }
          console.log(
            `[cloudflare-tunnel] 📊 SSL cleanup: ${mismatchedSslCerts.length} deleted`
          );
        }
      } else {
        debugLog("← Cleanup skipped", cleanupConfig);
      }

      const localTarget = getLocalTarget(serverHost, port);
      debugLog("← Connecting to local target", localTarget);
      // 4. Push ingress rules (public hostname → localhost)
      await cf(
        apiToken,
        "PUT",
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        {
          config: {
            ingress: [
              { hostname: hostname!, service: localTarget },
              { service: "http_status:404" }
            ]
          }
        }
      );

      // 5. DNS management

      // Helper to generate a special "tag" hostname for SSL certificates
      // Since SSL certs don't support metadata, we add a special hostname as a tag
      const generateSslTagHostname = () => {
        // we can't use .parentDomain because it's a wildcard domain and that causes an error
        return `cf-tunnel-plugin-${tunnelName}--${parentDomain}`;
      };

      if (dnsOption) {
        // Ensure wildcard CNAME record exists
        const ensureDnsRecord = async (type: "CNAME", content: string) => {
          const existingWildcard = await cf(
            apiToken,
            "GET",
            `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(dnsOption)}`,
            undefined,
            z.array(DNSRecordSchema)
          );
          if (existingWildcard.length === 0) {
            console.log(
              `[cloudflare-tunnel] Creating ${type} record for ${dnsOption}...`
            );
            await cf(
              apiToken,
              "POST",
              `/zones/${zoneId}/dns_records`,
              {
                type,
                name: dnsOption,
                content,
                proxied: true,
                comment: generateDnsComment()
              },
              DNSRecordSchema
            );
          }
        };

        await ensureDnsRecord("CNAME", `${tunnelId}.cfargotunnel.com`);
      } else {
        const wildcardDns = `*.${parentDomain}`;
        // check if there is an existing wildcard dns record for the parent domain
        const existingWildcard = await cf(
          apiToken,
          "GET",
          `/zones/${zoneId}/dns_records?type=CNAME&name=${wildcardDns}`,
          undefined,
          z.array(DNSRecordSchema)
        );
        if (existingWildcard.length === 0) {
          // Fallback: Ensure CNAME for specific hostname
          const existingDnsRecords = await cf(
            apiToken,
            "GET",
            `/zones/${zoneId}/dns_records?type=CNAME&name=${hostname!}`,
            undefined,
            z.array(DNSRecordSchema)
          );
          const existing = existingDnsRecords.length > 0;

          if (!existing) {
            console.log(
              `[cloudflare-tunnel] Creating DNS record for ${hostname}...`
            );
            await cf(
              apiToken,
              "POST",
              `/zones/${zoneId}/dns_records`,
              {
                type: "CNAME",
                name: hostname!,
                content: `${tunnelId}.cfargotunnel.com`,
                proxied: true,
                comment: generateDnsComment()
              },
              DNSRecordSchema
            );
          }
        }
      }

      // 6. Grab the tunnel token (single JWT string)
      const token = await cf(
        apiToken,
        "GET",
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
        undefined,
        z.string()
      );

      // 7. SSL management
      try {
        // Use the newer certificate packs endpoint (edge_certificates is deprecated)
        const certListRaw: any = await cf(
          apiToken,
          "GET",
          `/zones/${zoneId}/ssl/certificate_packs?status=all`,
          undefined,
          z.any()
        );
        const certPacks: any[] = Array.isArray(certListRaw)
          ? certListRaw
          : certListRaw.result || [];

        const certContainingHost = (host: string) =>
          certPacks.filter((c) =>
            (c.hostnames || c.hosts || []).includes(host)
          )?.[0];
        if (sslOption) {
          const isWildcard = sslOption.startsWith("*.");
          const certNeededHost = sslOption;

          const matchingCert = certContainingHost(certNeededHost);

          if (!matchingCert) {
            console.log(
              `[cloudflare-tunnel] Requesting ${isWildcard ? "wildcard " : ""}certificate for ${certNeededHost}...`
            );
            const tagHostname = generateSslTagHostname();
            const certificateHosts = [certNeededHost, tagHostname];
            debugLog(`Adding tag hostname to certificate: ${tagHostname}`);

            const newCert: any = await retryWithBackoff(() =>
              cf(
                apiToken,
                "POST",
                `/zones/${zoneId}/ssl/certificate_packs/order`,
                {
                  hosts: certificateHosts,
                  certificate_authority: "lets_encrypt",
                  type: "advanced",
                  validation_method: isWildcard ? "txt" : "http",
                  validity_days: 90,
                  cloudflare_branding: false
                }
              )
            );

            // Track the newly created certificate
            if (newCert && newCert.id) {
              trackSslCertificate(newCert.id, certificateHosts, tunnelName);
            }
          } else {
            debugLog("← Edge certificate already exists", matchingCert);
          }
        } else {
          const wildcardDomain = `*.${parentDomain}`;
          const wildcardExists = certContainingHost(wildcardDomain);
          if (!wildcardExists) {
            // Fetch Total TLS status from the new ACM endpoint
            const totalTls = await cf(
              apiToken,
              "GET",
              `/zones/${zoneId}/acm/total_tls`,
              undefined,
              z.object({ status: z.string() })
            );
            debugLog("← Total TLS", totalTls);
            const existingHostnameCert = certContainingHost(hostname!);
            if (totalTls.status !== "on" && !existingHostnameCert) {
              console.log(
                `[cloudflare-tunnel] Requesting edge certificate for ${hostname}...`
              );
              const tagHostname = generateSslTagHostname();
              const certificateHosts = [hostname!, tagHostname];
              debugLog(`Adding tag hostname to certificate: ${tagHostname}`);

              const newCert: any = await retryWithBackoff(() =>
                cf(
                  apiToken,
                  "POST",
                  `/zones/${zoneId}/ssl/certificate_packs/order`,
                  {
                    hosts: certificateHosts,
                    certificate_authority: "lets_encrypt",
                    type: "advanced",
                    validation_method: "txt",
                    validity_days: 90,
                    cloudflare_branding: false
                  }
                )
              );

              // Track the newly created certificate
              if (newCert && newCert.id) {
                trackSslCertificate(newCert.id, certificateHosts, tunnelName);
              }
            } else {
              debugLog(
                "← Edge certificate already exists",
                existingHostnameCert
              );
            }
          } else {
            debugLog(
              "← Edge certificate (wildcard) already exists",
              wildcardExists,
              wildcardDomain
            );
          }
        }
      } catch (sslError) {
        console.error(
          `[cloudflare-tunnel] ⚠️  SSL management error: ${(sslError as Error).message}`
        );
        throw sslError;
      }

      // 7. Fire up cloudflared
      const cloudflaredArgs = ["tunnel"];

      // Add logging options (these go before the 'run' subcommand)
      cloudflaredArgs.push("--loglevel", effectiveLogLevel);
      if (logFile) {
        cloudflaredArgs.push("--logfile", logFile);
      }

      // Log *then* add the token so token is not logged
      debugLog("Spawning cloudflared", bin, cloudflaredArgs);
      // Add the run subcommand and token
      cloudflaredArgs.push("run", "--token", token);
      child = spawn(bin, cloudflaredArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        // Keep child in same process group (default behavior)
        detached: false,
        // Prevent an extra console window on Windows and ensure compatibility
        windowsHide: true,
        // Use the system shell on Windows to properly locate .exe if needed
        shell: process.platform === "win32"
      });
      console.log(`[cloudflare-tunnel] Process spawned with PID: ${child.pid}`);

      // Expose to future plugin instances
      globalState.child = child;
      globalState.configHash = newConfigHash;

      // Register cleanup handlers now that we have a child process
      registerExitHandler();

      // Wait for tunnel to establish connection
      let tunnelReady = false;
      child.stdout?.on("data", (data) => {
        const output = data.toString();
        if (!globalState.shuttingDown || debug) {
          console.log(`[cloudflared stdout] ${output.trim()}`);
        }
        if (output.includes("Connection") && output.includes("registered")) {
          if (!tunnelReady) {
            tunnelReady = true;
            console.log(
              `🌐  Cloudflare tunnel started for https://${hostname}`
            );
          }
        }
      });

      child.stderr?.on("data", (data) => {
        const error = data.toString().trim();

        // Filter out noisy ICMP errors that don't affect functionality
        if (
          error.includes("Failed to parse ICMP reply") ||
          error.includes("unknow ip version 0")
        ) {
          // Only log ICMP errors in debug mode
          if (logLevel === "debug") {
            console.log(`[cloudflared debug] ${error}`);
          }
          return;
        }

        if (!globalState.shuttingDown || debug) {
          console.error(`[cloudflared stderr] ${error}`);
        }

        // Highlight actual errors and failures, but respect shutdown flag
        if (
          error.toLowerCase().includes("error") ||
          error.toLowerCase().includes("failed") ||
          error.toLowerCase().includes("fatal")
        ) {
          if (!globalState.shuttingDown || debug) {
            console.error(`[cloudflare-tunnel] ⚠️  ${error}`);
          }
        }
      });

      child.on("error", (error) => {
        console.error(
          `[cloudflare-tunnel] ❌ Failed to start tunnel process: ${error.message}`
        );
        if (error.message.includes("ENOENT")) {
          console.error(
            `[cloudflare-tunnel] Hint: cloudflared binary may not be installed correctly`
          );
        }
      });

      child.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
          console.error(
            `[cloudflare-tunnel] ❌ Tunnel process exited with code ${code}`
          );
          if (signal) {
            console.error(
              `[cloudflare-tunnel] Process terminated by signal: ${signal}`
            );
          }
        } else if (code === 0) {
          console.log(`[cloudflare-tunnel] ✅ Tunnel process exited cleanly`);
        }
      });

      // Fallback banner if we don't detect connection within reasonable time
      setTimeout(() => {
        if (!tunnelReady) {
          console.log(`🌐  Cloudflare tunnel starting for https://${hostname}`);
        }
      }, 3000);

      // Stop the tunnel when Vite shuts down
      server.httpServer?.once("close", () => {
        killCloudflared("SIGTERM");
      });

      // Handle the case where Vite chooses a different port due to conflicts
      server.httpServer?.on("listening", async () => {
        try {
          const { host: actualServerHost, port: actualPort } = normalizeAddress(
            server.httpServer?.address()
          );

          if (actualPort !== port) {
            console.log(
              `[cloudflare-tunnel] ⚠️  Port conflict detected - Vite is using port ${actualPort} instead of ${port}`
            );
            console.log(
              `[cloudflare-tunnel] 🔄 Updating tunnel configuration...`
            );

            // Update the tunnel configuration with the new port

            const newLocalTarget = getLocalTarget(
              actualServerHost,
              actualPort ?? port
            );

            debugLog("← Updating local target to", newLocalTarget);

            // Update ingress rules with the correct port
            await cf(
              apiToken,
              "PUT",
              `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
              {
                config: {
                  ingress: [
                    { hostname: hostname!, service: newLocalTarget },
                    { service: "http_status:404" }
                  ]
                }
              }
            );

            console.log(
              `[cloudflare-tunnel] ✅ Tunnel configuration updated to use port ${actualPort}`
            );

            // Update the global config hash to reflect the new port
            const updatedConfigHash = JSON.stringify({
              hostname,
              port: actualPort,
              tunnelName,
              dnsOption,
              sslOption
            });
            globalState.configHash = updatedConfigHash;
          }
        } catch (error) {
          console.error(
            `[cloudflare-tunnel] ❌ Failed to update tunnel for port change: ${(error as Error).message}`
          );
        }
      });
    } catch (error: any) {
      console.error(`[cloudflare-tunnel] ❌ Setup failed: ${error.message}`);

      // Provide helpful error context
      if (error.message.includes("API token")) {
        console.error(
          `[cloudflare-tunnel] 💡 Check your API token at: https://dash.cloudflare.com/profile/api-tokens`
        );
        console.error(
          `[cloudflare-tunnel] 💡 Required permissions: Zone:Zone:Read, Zone:DNS:Edit, Account:Cloudflare Tunnel:Edit`
        );
      } else if (
        error.message.includes("Zone") &&
        error.message.includes("not found")
      ) {
        console.error(
          `[cloudflare-tunnel] 💡 Make sure '${hostname}' domain is added to your Cloudflare account`
        );
      } else if (error.message.includes("cloudflared")) {
        console.error(
          `[cloudflare-tunnel] 💡 Try deleting node_modules and reinstalling to get a fresh cloudflared binary`
        );
      }

      throw error;
    }
  };

  return {
    name: "vite-plugin-cloudflare-tunnel",
    enforce: "pre",

    config(config) {
      // Load environment variables from .env files
      // dotEnvConfig();

      // Automatically configure Vite to allow tunnel hostname for named mode
      if (!config.server) {
        config.server = {};
      }

      // Skip hostname configuration for quick mode
      if (isQuickMode) {
        config.server.allowedHosts = [".trycloudflare.com"];

        return;
      }

      // Allow requests from the tunnel hostname for development
      if (!config.server.allowedHosts) {
        config.server.allowedHosts = [hostname!];
        console.log(
          `[cloudflare-tunnel] Configured Vite to allow requests from ${hostname}`
        );
      } else if (Array.isArray(config.server.allowedHosts)) {
        if (!config.server.allowedHosts.includes(hostname!)) {
          config.server.allowedHosts.push(hostname!);
          console.log(`[cloudflare-tunnel] Added ${hostname} to allowed hosts`);
        }
      }
      // return {
      //   build: {
      //     rollupOptions: {
      //       output: {
      //         manualChunks: {
      //           "vite-plugin-cloudflare-tunnel": [VIRTUAL_MODULE_ID]
      //         }
      //       }
      //     }
      //   }
      // }
    },

    configureServer(server) {
      // start the tunnel process but don't block on it in the pre hook
      const configuredPromise = configureServer(server);
      globalState.tunnelUrl = configuredPromise
        .then(() => tunnelUrl)
        .catch(() => "");
      return async () => {
        // now in the post hook, wait for the tunnel process to start
        await configuredPromise;
      };
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return "\0" + VIRTUAL_MODULE_ID;
      }
      return;
    },

    async load(id) {
      const tunnelUrl = await globalState.tunnelUrl;
      if (id === "\0" + VIRTUAL_MODULE_ID) {
        return `export function getTunnelUrl() { return ${JSON.stringify(tunnelUrl)}; }`;
      }
      return;
    },

    closeBundle() {
      killCloudflared("SIGTERM");
      delete globalState.child;
      delete globalState.configHash;
      delete globalState.shuttingDown;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Utility functions (extracted to remove duplication)                        */
/* -------------------------------------------------------------------------- */

/**
 * Normalize the result of server.address() to extract host and port in a
 * platform-agnostic way.
 */
function normalizeAddress(
  address: string | { address?: string; port?: number } | null | undefined
): { host: string; port?: number } {
  if (address && typeof address === "object") {
    return {
      host:
        "address" in address && address.address
          ? (address as any).address
          : "localhost",
      port:
        "port" in address && typeof (address as any).port === "number"
          ? (address as any).port
          : undefined
    };
  }
  return { host: "localhost" };
}

/**
 * Ensure that the cloudflared binary exists on disk, installing it if missing.
 * @param binPath - Path where the binary should live.
 */
async function ensureCloudflaredBinary(binPath: string) {
  try {
    await fs.access(binPath);
  } catch {
    console.log("[cloudflare-tunnel] Installing cloudflared binary...");
    await install(binPath);
  }
}

/**
 * Build a http://host:port URL suitable for cloudflared ingress rules,
 * correctly handling IPv6 addresses.
 */
function getLocalTarget(host: string, port: number): string {
  const isIpv6 = host.includes(":");
  return `http://${isIpv6 ? `[${host}]` : host}:${port}`;
}

// Export both as named export and default export
export { cloudflareTunnel };
export default cloudflareTunnel;
