import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DOCS_HOST,
  FILES_HOST,
  PREVIEW_HOST,
  WORKSPACE_DAEMON_PORT
} from "./shared";

/**
 * The docs the agent reads at http://docs.internal/: a few static pages
 * that say how to build the demo site. A `fetcher` host, so Browser Run
 * calls this entrypoint directly and the agent never wakes for it.
 */
export class DocsSite extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const page = PAGES[path];
    if (!page) {
      return html(
        "Not found",
        `<p>There's no page at <code>${escape(path)}</code>.</p>${NAV}`,
        404
      );
    }
    return html(page.title, page.body);
  }
}

function escape(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char
  );
}

function html(title: string, body: string, status = 200): Response {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} · Launch docs</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
  pre { background: #f6f8fa; padding: 0.75rem 1rem; overflow-x: auto; border-radius: 6px; }
  code { font-family: ui-monospace, monospace; font-size: 0.9em; }
  nav { margin-top: 2.5rem; border-top: 1px solid #d0d7de; padding-top: 1rem; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
  return new Response(page, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

const NAV = `<nav>
  <a href="/">Home</a> ·
  <a href="/getting-started">Getting started</a> ·
  <a href="/spec">The site to build</a> ·
  <a href="/preview">Previewing your work</a>
</nav>`;

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0", // reachable from outside the container
    port: 5173,
    strictPort: true, // fail instead of moving to another port
    allowedHosts: ["${PREVIEW_HOST}"], // the browser's Host header
    hmr: false, // no WebSockets reach the browser, so no hot reload
    watch: { usePolling: true } // notice files synced into the container
  }
});`;

const PAGES: Record<string, { title: string; body: string }> = {
  "/": {
    title: "Launch docs",
    body: `<p>These docs tell you how to build the demo site: a one-page launch
countdown, in React with Vite, inside your workspace container. Read every
page before you start.</p>
<ol>
  <li><a href="/getting-started">Getting started</a>: install the starter
  template and run its dev server.</li>
  <li><a href="/spec">The site to build</a>: what it looks like and what
  it does.</li>
  <li><a href="/preview">Previewing your work</a>: open the dev server and
  the production build in your browser.</li>
</ol>
${NAV}`
  },

  "/getting-started": {
    title: "Getting started",
    body: `<p>Run these with <code>exec</code>. They run in your workspace's
Linux container, which has Node.js 22, npm and git, and can reach npm.
None of them asks a question.</p>

<h2>1. Install the starter</h2>
<pre><code>cd /workspace &amp;&amp; npm create vite@latest launch -- --template react --no-interactive</code></pre>
<p>This creates <code>/workspace/launch</code>: a React app with
<code>src/App.jsx</code>, <code>src/App.css</code>,
<code>src/index.css</code> and <code>index.html</code>.</p>

<h2>2. Configure the dev server</h2>
<p>Replace <code>/workspace/launch/vite.config.js</code> with this, or the
browser can't load the dev server:</p>
<pre><code>${escape(VITE_CONFIG)}</code></pre>
<p>Never use port ${WORKSPACE_DAEMON_PORT}: the workspace daemon owns it.</p>

<h2>3. Install and start the dev server</h2>
<p>Start it in the background, so <code>exec</code> returns:</p>
<pre><code>cd /workspace/launch &amp;&amp; npm install --no-audit --no-fund
cd /workspace/launch &amp;&amp; setsid nohup npm run dev &gt; /tmp/dev-server.log 2&gt;&amp;1 &lt; /dev/null &amp;
sleep 3; curl -sS -o /dev/null -w "%{http_code}\\n" http://localhost:5173/ || tail -n 30 /tmp/dev-server.log</code></pre>
<p>A <code>200</code> means it's up. <code>node_modules</code> stays on the
container's disk. If the container restarted (<code>node_modules</code> is
missing, or nothing answers on the port), run <code>npm install</code> and
start the dev server again.</p>
${NAV}`
  },

  "/spec": {
    title: "The site to build",
    body: `<p>A one-page launch countdown for the fictional
<strong>Kestrel 1</strong> rocket. Replace the starter's
<code>App.jsx</code> and its CSS.</p>
<ul>
  <li>A dark navy page with one centered card, and orange (#f6821f) as the
  accent colour.</li>
  <li>A heading, "Kestrel 1 launch", and a large T-minus clock that counts
  down from 10:00 once a second.</li>
  <li>A pre-launch checklist of four items: Fuel loaded, Weather go,
  Range clear, Crew strapped in. Clicking an item toggles it done, with a
  strike-through.</li>
  <li>A progress bar under the checklist showing how many items are done.</li>
  <li>A "Launch" button, disabled until all four items are done. Pressing
  it stops the clock and shows "Liftoff!" in large text.</li>
  <li>No external scripts, styles, fonts or images: the browser can only
  reach the internal hostnames.</li>
</ul>
${NAV}`
  },

  "/preview": {
    title: "Previewing your work",
    body: `<p>Your browser can't reach <code>localhost</code> or the container.
It opens your work on internal hostnames instead. Point one somewhere with
<code>hosts.assign</code> in your browser code, then navigate to the URL it
returns. An assignment sticks until you change it.</p>

<h2>The dev server: ${PREVIEW_HOST}</h2>
<pre><code>async () =&gt; {
  const { url } = await hosts.assign({ host: "${PREVIEW_HOST}", target: { port: 5173 } });
  await cdp.send({ method: "Page.navigate", params: { url }, sessionId: "active" });
}</code></pre>
<p>Wait for the page to load before you read it. After you change files,
reload the page (<code>Page.reload</code>); there's no hot reload. A 502
that says nothing answers on the port means the dev server isn't running:
check <code>/tmp/dev-server.log</code> and start it again.</p>

<h2>The production build: ${FILES_HOST}</h2>
<p>${FILES_HOST} serves the static files in a workspace folder, with no
server process. Build, then point it at <code>dist</code>:</p>
<pre><code>cd /workspace/launch &amp;&amp; npm run build</code></pre>
<pre><code>async () =&gt; {
  const { url } = await hosts.assign({ host: "${FILES_HOST}", target: { folder: "/workspace/launch/dist" } });
  await cdp.send({ method: "Page.navigate", params: { url }, sessionId: "active" });
}</code></pre>

<h2>Checking the site</h2>
<p>Read the page, click through it, and take a viewport screenshot so the
user can see it. These docs stay at http://${DOCS_HOST}/.</p>
${NAV}`
  }
};
