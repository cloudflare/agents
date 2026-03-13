/**
 * Option parsing for curl command
 */

import type { ExecResult } from "../../types";
import { unknownOption } from "../help";
import { encodeFormData, parseFormField } from "./form";
import type { CurlOptions } from "./types";

/**
 * Parse curl command line arguments
 */
export function parseOptions(args: string[]): CurlOptions | ExecResult {
  const options: CurlOptions = {
    method: "GET",
    // Use null-prototype to prevent prototype pollution via user-controlled header names
    headers: Object.create(null) as Record<string, string>,
    dataBinary: false,
    formFields: [],
    useRemoteName: false,
    headOnly: false,
    includeHeaders: false,
    silent: false,
    showError: false,
    failSilently: false,
    followRedirects: true,
    verbose: false
  };

  let impliesPost = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-X" || arg === "--request") {
      options.method = args[++i] ?? "GET";
    } else if (arg.startsWith("-X")) {
      options.method = arg.slice(2);
    } else if (arg.startsWith("--request=")) {
      options.method = arg.slice(10);
    } else if (arg === "-H" || arg === "--header") {
      const header = args[++i];
      if (header) {
        const colonIndex = header.indexOf(":");
        if (colonIndex > 0) {
          const name = header.slice(0, colonIndex).trim();
          const value = header.slice(colonIndex + 1).trim();
          options.headers[name] = value;
        }
      }
    } else if (arg.startsWith("--header=")) {
      const header = arg.slice(9);
      const colonIndex = header.indexOf(":");
      if (colonIndex > 0) {
        const name = header.slice(0, colonIndex).trim();
        const value = header.slice(colonIndex + 1).trim();
        options.headers[name] = value;
      }
    } else if (arg === "-d" || arg === "--data" || arg === "--data-raw") {
      options.data = args[++i] ?? "";
      impliesPost = true;
    } else if (arg.startsWith("-d")) {
      options.data = arg.slice(2);
      impliesPost = true;
    } else if (arg.startsWith("--data=")) {
      options.data = arg.slice(7);
      impliesPost = true;
    } else if (arg.startsWith("--data-raw=")) {
      options.data = arg.slice(11);
      impliesPost = true;
    } else if (arg === "--data-binary") {
      options.data = args[++i] ?? "";
      options.dataBinary = true;
      impliesPost = true;
    } else if (arg.startsWith("--data-binary=")) {
      options.data = arg.slice(14);
      options.dataBinary = true;
      impliesPost = true;
    } else if (arg === "--data-urlencode") {
      const value = args[++i] ?? "";
      options.data =
        (options.data ? `${options.data}&` : "") + encodeFormData(value);
      impliesPost = true;
    } else if (arg.startsWith("--data-urlencode=")) {
      const value = arg.slice(17);
      options.data =
        (options.data ? `${options.data}&` : "") + encodeFormData(value);
      impliesPost = true;
    } else if (arg === "-F" || arg === "--form") {
      const formData = args[++i] ?? "";
      const field = parseFormField(formData);
      if (field) {
        options.formFields.push(field);
      }
      impliesPost = true;
    } else if (arg.startsWith("--form=")) {
      const formData = arg.slice(7);
      const field = parseFormField(formData);
      if (field) {
        options.formFields.push(field);
      }
      impliesPost = true;
    } else if (arg === "-u" || arg === "--user") {
      options.user = args[++i];
    } else if (arg.startsWith("-u")) {
      options.user = arg.slice(2);
    } else if (arg.startsWith("--user=")) {
      options.user = arg.slice(7);
    } else if (arg === "-A" || arg === "--user-agent") {
      options.headers["User-Agent"] = args[++i] ?? "";
    } else if (arg.startsWith("-A")) {
      options.headers["User-Agent"] = arg.slice(2);
    } else if (arg.startsWith("--user-agent=")) {
      options.headers["User-Agent"] = arg.slice(13);
    } else if (arg === "-e" || arg === "--referer") {
      options.headers.Referer = args[++i] ?? "";
    } else if (arg.startsWith("-e")) {
      options.headers.Referer = arg.slice(2);
    } else if (arg.startsWith("--referer=")) {
      options.headers.Referer = arg.slice(10);
    } else if (arg === "-b" || arg === "--cookie") {
      options.headers.Cookie = args[++i] ?? "";
    } else if (arg.startsWith("-b")) {
      options.headers.Cookie = arg.slice(2);
    } else if (arg.startsWith("--cookie=")) {
      options.headers.Cookie = arg.slice(9);
    } else if (arg === "-c" || arg === "--cookie-jar") {
      options.cookieJar = args[++i];
    } else if (arg.startsWith("--cookie-jar=")) {
      options.cookieJar = arg.slice(13);
    } else if (arg === "-T" || arg === "--upload-file") {
      options.uploadFile = args[++i];
      if (options.method === "GET") {
        options.method = "PUT";
      }
    } else if (arg.startsWith("--upload-file=")) {
      options.uploadFile = arg.slice(14);
      if (options.method === "GET") {
        options.method = "PUT";
      }
    } else if (arg === "-m" || arg === "--max-time") {
      const secs = parseFloat(args[++i] ?? "0");
      if (!Number.isNaN(secs) && secs > 0) {
        options.timeoutMs = secs * 1000;
      }
    } else if (arg.startsWith("--max-time=")) {
      const secs = parseFloat(arg.slice(11));
      if (!Number.isNaN(secs) && secs > 0) {
        options.timeoutMs = secs * 1000;
      }
    } else if (arg === "--connect-timeout") {
      const secs = parseFloat(args[++i] ?? "0");
      if (!Number.isNaN(secs) && secs > 0) {
        // Use connect-timeout as overall timeout if max-time not set
        if (options.timeoutMs === undefined) {
          options.timeoutMs = secs * 1000;
        }
      }
    } else if (arg.startsWith("--connect-timeout=")) {
      const secs = parseFloat(arg.slice(18));
      if (!Number.isNaN(secs) && secs > 0) {
        if (options.timeoutMs === undefined) {
          options.timeoutMs = secs * 1000;
        }
      }
    } else if (arg === "-o" || arg === "--output") {
      options.outputFile = args[++i];
    } else if (arg.startsWith("--output=")) {
      options.outputFile = arg.slice(9);
    } else if (arg === "-O" || arg === "--remote-name") {
      options.useRemoteName = true;
    } else if (arg === "-I" || arg === "--head") {
      options.headOnly = true;
      options.method = "HEAD";
    } else if (arg === "-i" || arg === "--include") {
      options.includeHeaders = true;
    } else if (arg === "-s" || arg === "--silent") {
      options.silent = true;
    } else if (arg === "-S" || arg === "--show-error") {
      options.showError = true;
    } else if (arg === "-f" || arg === "--fail") {
      options.failSilently = true;
    } else if (arg === "-L" || arg === "--location") {
      options.followRedirects = true;
    } else if (arg === "--max-redirs") {
      // Handled by the network config, skip the value
      i++;
    } else if (arg.startsWith("--max-redirs=")) {
      // Handled by the network config
    } else if (arg === "-w" || arg === "--write-out") {
      options.writeOut = args[++i];
    } else if (arg.startsWith("--write-out=")) {
      options.writeOut = arg.slice(12);
    } else if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("--") && arg !== "--") {
      return unknownOption("curl", arg);
    } else if (arg.startsWith("-") && arg !== "-") {
      // Handle combined short options like -sS
      for (const c of arg.slice(1)) {
        switch (c) {
          case "s":
            options.silent = true;
            break;
          case "S":
            options.showError = true;
            break;
          case "f":
            options.failSilently = true;
            break;
          case "L":
            options.followRedirects = true;
            break;
          case "I":
            options.headOnly = true;
            options.method = "HEAD";
            break;
          case "i":
            options.includeHeaders = true;
            break;
          case "O":
            options.useRemoteName = true;
            break;
          case "v":
            options.verbose = true;
            break;
          default:
            return unknownOption("curl", `-${c}`);
        }
      }
    } else if (!arg.startsWith("-")) {
      options.url = arg;
    }
  }

  // Data/form options imply POST when no explicit method was set
  if (impliesPost && options.method === "GET") {
    options.method = "POST";
  }

  return options;
}
