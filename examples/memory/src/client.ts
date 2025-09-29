export default `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API Explorer</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      // Tron-ish palette via Tailwind CDN config
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              bg: "#0b0d10",        // page background
              surface: "#0e1217",   // cards/inputs
              border: "#17202b",    // default borders
              ink: "#e6f0f8",       // primary text
              muted: "#9aa4b2",     // secondary text
              accent: "#00e5ff"     // electric cyan
            },
            boxShadow: {
              soft: "0 0 0 1px rgba(0,229,255,0.15), 0 1px 0 0 rgba(255,255,255,0.04) inset"
            }
          }
        }
      }
    </script>
  </head>
  <body class="min-h-screen bg-bg text-ink">
    <div class="max-w-3xl mx-auto p-6">
      <h1 class="text-2xl font-semibold text-ink">API Explorer</h1>
      <p class="text-muted mt-1">
        Search summarized API endpoints and view raw results.
      </p>
      <div class="mt-4 grid gap-2 md:grid-cols-3">
      <input
        id="agent"
        type="text"
        placeholder="agent name (e.g. memory)"
        class="border border-border bg-surface/80 px-3 py-2 text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50"
      />
      <input
        id="idz"
        type="file"
        accept=".idz,application/json"
        class="border border-border bg-surface/80 px-3 py-2 text-ink placeholder:text-muted file:mr-3 file:px-3 file:py-1 file:bg-accent/10 file:border-0 file:text-ink/90"
      />
      <button
        id="importBtn"
        type="button"
        class="border border-accent/50 bg-transparent px-4 py-2 text-ink font-medium shadow-sm hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Import
      </button>
    </div>

      <div class="mt-6 flex gap-2">
        <input
          id="query"
          type="text"
          placeholder="e.g. create user, list invoices, GET /users/:id"
          class="flex-1 border border-border bg-surface/80 px-3 py-2 text-ink shadow-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50"
        />
         <input
          id="k"
          type="number"
          inputmode="numeric"
          min="1"
          max="50"
          value="5"
          placeholder="k"
          title="Number of results (top-k)"
          class="w-16 border border-border bg-surface/80 px-2 py-2 text-ink text-center placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50"
        />
        <button
          id="recallBtn"
          type="button"
          class="border border-accent/50 bg-transparent px-4 py-2 text-ink font-medium shadow-sm hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Recall
        </button>
      </div>

      <div id="status" class="mt-3 text-sm text-muted"></div>

      <div class="mt-6">
        <!-- results list -->
        <div id="output" class="space-y-4"></div>
      </div>
    </div>

    <script>
      const queryInput = document.getElementById("query");
      const recallBtn = document.getElementById("recallBtn");
      const statusEl = document.getElementById("status");
      const outputEl = document.getElementById("output");
      const agentInput = document.getElementById("agent");
      const idzInput = document.getElementById("idz");
      const kInput = document.getElementById("k");
      const importBtn = document.getElementById("importBtn");

      agentInput.value = localStorage.getItem("agentName") || "";
      agentInput.addEventListener("input", () => {
        localStorage.setItem("agentName", agentInput.value.trim());
      });

      function agentBase() {
        const name = (agentInput.value || "").trim();
        if (!name) throw new Error("Set an agent name first.");
        return \`/agents/agent/\${encodeURIComponent(name)}\`;
      }

      function el(tag, classes = "", text = "") {
        const node = document.createElement(tag);
        if (classes) node.className = classes;
        if (text !== "") node.textContent = text;
        return node;
      }

      function tryPrettyJSON(maybeJSON) {
        if (typeof maybeJSON !== "string") {
          try { return JSON.stringify(maybeJSON, null, 2); } catch { return String(maybeJSON ?? ""); }
        }
        try { return JSON.stringify(JSON.parse(maybeJSON), null, 2); }
        catch { return maybeJSON.trim(); }
      }

      function renderEntry(item) {
        const meta = item?.metadata ?? {};
        const method = String(meta.method || "").toUpperCase();
        const endpoint = meta.endpoint || "";
        const title = item?.content || meta.summary || "";
        const desc = meta.description || "";
        const params = Array.isArray(meta.parameters) ? meta.parameters : null;
        const requestBody = meta.requestBody;

        const card = el("div", "relative border border-border bg-surface/90 p-4 shadow-soft hover:border-accent/40 transition-colors");
        // subtle accent rail (Tron line)
        const rail = el("div", "pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-accent/60");
        card.appendChild(rail);

        // Header: [METHOD] {endpoint} with a minimal badge
        const header = el("div", "flex items-center gap-2 font-mono text-sm");
        const methodBadge = el("span", "inline-flex items-center border border-accent/60 px-1.5 py-0.5 text-[10px] leading-none tracking-wider");
        methodBadge.textContent = method || "—";
        const ep = el("span", "text-ink/90 break-all", endpoint);
        header.append(methodBadge, ep);
        card.appendChild(header);

        // Title
        if (title) {
          const h = el("div", "mt-1 text-ink font-semibold");
          h.textContent = title;
          card.appendChild(h);
        }

        // Description
        if (desc) {
          const d = el("div", "mt-1 text-muted");
          d.textContent = desc;
          card.appendChild(d);
        }

        // Parameters
        if (params && params.length) {
          const wrap = el("div", "mt-3");
          const label = el("div", "text-xs uppercase tracking-wide text-muted", "Parameters");
          const ul = el("ul", "mt-1 list-disc pl-5 text-sm text-ink/90");
          params.forEach(p => {
            const li = el("li");
            li.textContent = p;
            ul.appendChild(li);
          });
          wrap.appendChild(label);
          wrap.appendChild(ul);
          card.appendChild(wrap);
        }

        // Request Body (pretty)
        if (requestBody !== undefined && requestBody !== null && String(requestBody).trim() !== "") {
          const wrap = el("div", "mt-3");
          const label = el("div", "text-xs uppercase tracking-wide text-muted", "Request Body");
          const pre = el("pre", "mt-1 whitespace-pre-wrap border border-border bg-black/50 text-ink p-3 text-xs overflow-auto");
          pre.textContent = tryPrettyJSON(requestBody);
          wrap.appendChild(label);
          wrap.appendChild(pre);
          card.appendChild(wrap);
        }

        // Raw dropdown
        const details = el("details", "mt-3");
        const summary = el("summary", "cursor-pointer text-sm text-ink/90 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 px-1 inline", "Raw");
        const raw = el("pre", "mt-2 whitespace-pre-wrap border border-border bg-black/40 text-ink p-3 text-xs overflow-auto");
        raw.textContent = JSON.stringify(item, null, 2);
        details.appendChild(summary);
        details.appendChild(raw);
        card.appendChild(details);

        return card;
      }

      function renderResults(json) {
        outputEl.innerHTML = "";
        const list = Array.isArray(json?.result) ? json.result : [];
        if (!list.length) {
          const empty = el("div", "text-sm text-muted", "No results.");
          outputEl.appendChild(empty);
          return;
        }
        list.forEach(item => outputEl.appendChild(renderEntry(item)));
      }

      async function recall() {
        const query = queryInput.value.trim();
        if (!query) return;
        recallBtn.disabled = true;
        statusEl.textContent = "Searching...";
        outputEl.innerHTML = "";
        try {
          const kRaw = Number(kInput?.value ?? "");
          const k = Number.isFinite(kRaw) && kRaw > 0 ? Math.min(kRaw, 50) : undefined;
          const res = await fetch(\`\${agentBase()}/recall\`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, k })
          });
          if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
          const json = await res.json();
          renderResults(json);
          statusEl.textContent = "";
        } catch (e) {
          statusEl.textContent = e instanceof Error ? e.message : String(e);
        } finally {
          recallBtn.disabled = false;
        }
      }
      
      async function doImport() {
        const file = idzInput.files?.[0];
        if (!file) {
          statusEl.textContent = "Pick a .idz (or JSON) file first.";
          return;
        }
        importBtn.disabled = true;
        statusEl.textContent = "Importing...";
        outputEl.innerHTML = "";
        try {
          const text = await file.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error("File is not valid JSON.");
          }
          // Accept either an array directly, or { entries: [...] }
          const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
          if (!Array.isArray(entries)) {
            throw new Error("Expected an array of entries or { entries: [...] }.");
          }

          const res = await fetch(\`\${agentBase()}/import\`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entries })
          });
          if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
          const json = await res.json();
          statusEl.textContent = json?.result || "Imported.";
        } catch (e) {
          statusEl.textContent = e instanceof Error ? e.message : String(e);
        } finally {
          importBtn.disabled = false;
        }
      }

      importBtn.addEventListener("click", doImport);

      recallBtn.addEventListener("click", recall);
      queryInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          recall();
        }
      });
    </script>
  </body>
</html>
`;
