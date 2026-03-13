/**
 * Help text for curl command
 */

export const curlHelp: {
  name: string;
  summary: string;
  usage: string;
  options: string[];
} = {
  name: "curl",
  summary: "transfer a URL",
  usage: "curl [OPTIONS] URL",
  options: [
    "-X, --request METHOD  HTTP method (GET, POST, PUT, DELETE, etc.)",
    "-H, --header HEADER   Add header (can be used multiple times)",
    "-d, --data DATA       HTTP POST data",
    "    --data-raw DATA   HTTP POST data (no @ interpretation)",
    "    --data-binary DATA  HTTP POST binary data",
    "    --data-urlencode DATA  URL-encode and POST data",
    "-F, --form NAME=VALUE  Multipart form data",
    "-u, --user USER:PASS  HTTP authentication",
    "-A, --user-agent STR  Set User-Agent header",
    "-e, --referer URL     Set Referer header",
    "-b, --cookie DATA     Send cookies (name=value or @file)",
    "-c, --cookie-jar FILE Save cookies to file",
    "-T, --upload-file FILE  Upload file (PUT)",
    "-o, --output FILE     Write output to file",
    "-O, --remote-name     Write to file named from URL",
    "-I, --head            Show headers only (HEAD request)",
    "-i, --include         Include response headers in output",
    "-s, --silent          Silent mode (no progress)",
    "-S, --show-error      Show errors even when silent",
    "-f, --fail            Fail silently on HTTP errors (no output)",
    "-L, --location        Follow redirects (default)",
    "    --max-redirs NUM  Maximum redirects (default: 20)",
    "-m, --max-time SECS   Maximum time for request",
    "    --connect-timeout SECS  Connection timeout",
    "-w, --write-out FMT   Output format after completion",
    "-v, --verbose         Verbose output",
    "    --help            Display this help and exit",
    "",
    "Note: Network access must be configured via BashEnv network option.",
    "      curl is not available by default for security reasons."
  ]
};
