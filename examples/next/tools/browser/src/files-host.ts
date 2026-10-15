import type { Workspace } from "@cloudflare/computer";
import { z } from "zod";

/** What the model passes to `hosts.assign()` for files.internal. */
export const filesTarget = z.object({
  folder: z
    .string()
    .regex(/^\/workspace\//, "Use an absolute path under /workspace/")
    .refine((folder) => !folder.split("/").includes(".."), {
      message: "The folder can't contain .."
    })
    .describe(
      "The workspace folder to serve, such as /workspace/my-app/dist. Its index.html is the site's home page."
    )
});

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2"
};

function contentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Serve one browser request to files.internal from a workspace folder:
 * `/` and other directory paths serve their `index.html`, and a missing
 * file is a 404. It reads the Workspace's own files, so it needs no
 * container: a built `dist/` keeps working after the container sleeps.
 */
export async function serveWorkspaceFolder(
  workspace: Workspace,
  request: Request,
  folder: string
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const segments = decodeURIComponent(pathname).split("/").filter(Boolean);
  if (segments.includes("..")) {
    return new Response("Bad path\n", { status: 400 });
  }
  let path = [folder.replace(/\/+$/, ""), ...segments].join("/");
  try {
    if ((await workspace.fs.stat(path)).isDirectory) path += "/index.html";
    return new Response(await workspace.fs.readFile(path), {
      headers: {
        "content-type": contentType(path),
        "cache-control": "no-store"
      }
    });
  } catch {
    return new Response(`${path} isn't in the workspace\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
}
