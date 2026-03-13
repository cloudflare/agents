/**
 * curl - Transfer data from or to a server
 *
 * This is a simplified implementation of curl that uses the secure fetch wrapper.
 * Network access must be explicitly configured via BashEnvOptions.network.
 */

import { getErrorMessage } from "../../interpreter/helpers/errors";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";
import { nullPrototypeCopy } from "../query-engine/safe-object";
import { generateMultipartBody } from "./form";
import { curlHelp } from "./help";
import { parseOptions } from "./parse";
import {
  applyWriteOut,
  extractFilename,
  formatHeaders
} from "./response-formatting";
import type { CurlOptions } from "./types";

/**
 * Prepare request body from options, reading files if needed
 */
async function prepareRequestBody(
  options: CurlOptions,
  ctx: CommandContext
): Promise<{ body?: string; contentType?: string }> {
  // Handle -T/--upload-file
  if (options.uploadFile) {
    const filePath = ctx.fs.resolvePath(ctx.cwd, options.uploadFile);
    const content = await ctx.fs.readFile(filePath);
    return { body: content };
  }

  // Handle -F/--form multipart data
  if (options.formFields.length > 0) {
    const fileContents = new Map<string, string>();

    // Read any file references
    for (const field of options.formFields) {
      if (field.value.startsWith("@") || field.value.startsWith("<")) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, field.value.slice(1));
        try {
          const content = await ctx.fs.readFile(filePath);
          fileContents.set(field.value.slice(1), content);
        } catch {
          // File not found, use empty string
          fileContents.set(field.value.slice(1), "");
        }
      }
    }

    const { body, boundary } = generateMultipartBody(
      options.formFields,
      fileContents
    );
    return {
      body,
      contentType: `multipart/form-data; boundary=${boundary}`
    };
  }

  // Handle -d/--data variants
  if (options.data !== undefined) {
    return { body: options.data };
  }

  // @banned-pattern-ignore: returns typed object with known keys (body, contentType), not user data
  return {};
}

/**
 * Prepare request headers from options.
 * Uses null-prototype object to prevent prototype pollution from user-controlled header names.
 */
function prepareHeaders(
  options: CurlOptions,
  contentType?: string
): Record<string, string> {
  const headers = nullPrototypeCopy(options.headers ?? {});

  // Add authentication header
  if (options.user) {
    const encoded = Buffer.from(options.user).toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  }

  // Set content type if needed and not already set
  if (contentType && !headers["Content-Type"]) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}

/**
 * Save cookies from response to cookie jar file
 */
async function saveCookies(
  options: CurlOptions,
  headers: Record<string, string>,
  ctx: CommandContext
): Promise<void> {
  if (!options.cookieJar) return;

  const setCookie = headers["set-cookie"];
  if (!setCookie) return;

  const filePath = ctx.fs.resolvePath(ctx.cwd, options.cookieJar);
  // Simple format: just save the raw Set-Cookie values
  await ctx.fs.writeFile(filePath, setCookie);
}

/**
 * Build output string from response
 */
function buildOutput(
  options: CurlOptions,
  result: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    url: string;
  },
  requestUrl: string
): string {
  let output = "";

  // Verbose output
  if (options.verbose) {
    output += `> ${options.method} ${requestUrl}\n`;
    for (const [name, value] of Object.entries(options.headers)) {
      output += `> ${name}: ${value}\n`;
    }
    output += ">\n";
    output += `< HTTP/1.1 ${result.status} ${result.statusText}\n`;
    for (const [name, value] of Object.entries(result.headers)) {
      output += `< ${name}: ${value}\n`;
    }
    output += "<\n";
  }

  // Include headers with -i/--include
  if (options.includeHeaders && !options.verbose) {
    output += `HTTP/1.1 ${result.status} ${result.statusText}\r\n`;
    output += formatHeaders(result.headers);
    output += "\r\n\r\n";
  }

  // Add body (unless head-only mode)
  if (!options.headOnly) {
    output += result.body;
  } else if (options.includeHeaders || options.verbose) {
    // For HEAD, we already showed headers
  } else {
    // HEAD without -i shows headers
    output += `HTTP/1.1 ${result.status} ${result.statusText}\r\n`;
    output += formatHeaders(result.headers);
    output += "\r\n";
  }

  // Write-out format
  if (options.writeOut) {
    output += applyWriteOut(options.writeOut, {
      status: result.status,
      headers: result.headers,
      url: result.url,
      bodyLength: result.body.length
    });
  }

  return output;
}

export const curlCommand: Command = {
  name: "curl",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(curlHelp);
    }

    // Parse options first to report option errors before network check
    const parseResult = parseOptions(args);
    if ("exitCode" in parseResult) {
      return parseResult;
    }

    const options = parseResult;

    // Check for URL
    if (!options.url) {
      return {
        stdout: "",
        stderr: "curl: no URL specified\n",
        exitCode: 2
      };
    }

    // ctx.fetch is always available when curl command exists (curl is only registered with network config)
    if (!ctx.fetch) {
      return {
        stdout: "",
        stderr: "curl: internal error: fetch not available\n",
        exitCode: 1
      };
    }

    // Normalize URL - add https:// if no protocol
    let url = options.url;
    if (!url.match(/^https?:\/\//)) {
      url = `https://${url}`;
    }

    try {
      // Prepare body and headers
      const { body, contentType } = await prepareRequestBody(options, ctx);
      const headers = prepareHeaders(options, contentType);

      const result = await ctx.fetch(url, {
        method: options.method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body,
        followRedirects: options.followRedirects,
        timeoutMs: options.timeoutMs
      });

      // Save cookies if requested
      await saveCookies(options, result.headers, ctx);

      // Check for HTTP errors with -f/--fail
      if (options.failSilently && result.status >= 400) {
        const stderr =
          options.showError || !options.silent
            ? `curl: (22) The requested URL returned error: ${result.status}\n`
            : "";
        return { stdout: "", stderr, exitCode: 22 };
      }

      let output = buildOutput(options, result, url);

      // Write to file
      if (options.outputFile || options.useRemoteName) {
        const filename = options.outputFile || extractFilename(url);
        const filePath = ctx.fs.resolvePath(ctx.cwd, filename);
        await ctx.fs.writeFile(filePath, options.headOnly ? "" : result.body);

        // When writing to file, don't output body to stdout unless verbose
        if (!options.verbose) {
          output = "";
        }

        // Add write-out after file write
        if (options.writeOut) {
          output = applyWriteOut(options.writeOut, {
            status: result.status,
            headers: result.headers,
            url: result.url,
            bodyLength: result.body.length
          });
        }
      }

      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (error) {
      const message = getErrorMessage(error);

      // Determine exit code based on error type
      let exitCode = 1;
      if (message.includes("Network access denied")) {
        exitCode = 7; // CURLE_COULDNT_CONNECT
      } else if (
        message.includes("HTTP method") &&
        message.includes("not allowed")
      ) {
        exitCode = 3; // CURLE_URL_MALFORMAT-like (method restriction)
      } else if (message.includes("Redirect target not in allow-list")) {
        exitCode = 47; // CURLE_TOO_MANY_REDIRECTS-like
      } else if (message.includes("Too many redirects")) {
        exitCode = 47; // CURLE_TOO_MANY_REDIRECTS
      } else if (message.includes("aborted")) {
        exitCode = 28; // CURLE_OPERATION_TIMEDOUT
      }

      // Silent mode suppresses error output unless -S is used
      const showErr = !options.silent || options.showError;
      const stderr = showErr ? `curl: (${exitCode}) ${message}\n` : "";

      return { stdout: "", stderr, exitCode };
    }
  }
};
