export default `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>x402 MCP</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="mx-auto max-w-5xl p-4 md:p-8">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-semibold">x402 🧡 MCP</h1>
      <div class="flex items-center gap-2">
        <span id="status-dot" class="inline-block h-3 w-3 rounded-full bg-red-500"></span>
        <span id="status-text" class="text-sm text-slate-600">Disconnected</span>
      </div>
    </header>

    <!-- Tools -->
    <section class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      <!-- Echo (free) -->
      <div class="rounded-2xl bg-white p-4 shadow">
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Echo <span class="text-xs font-normal text-green-600">(free)</span></h2>
        </div>
        <form id="echo-form" class="flex flex-col gap-3">
          <label>
            <span class="mb-1 block text-sm text-slate-600">Message</span>
            <input id="echo-input" type="text" class="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 focus:border-slate-500 focus:outline-none" placeholder="hello world" />
          </label>
          <button class="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800" type="submit">Call echo</button>
        </form>
      </div>

      <!-- Square (paid) -->
      <div class="rounded-2xl bg-white p-4 shadow">
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-lg font-semibold">Square <span class="text-xs font-normal text-blue-600">($0.01)</span></h2>
        </div>
        <form id="square-form" class="flex flex-col gap-3">
          <label>
            <span class="mb-1 block text-sm text-slate-600">Number</span>
            <input id="square-input" type="number" step="1" class="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 focus:border-slate-500 focus:outline-none" placeholder="5" />
          </label>
          <button class="rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-500" type="submit">Call square (paid)</button>
          <p class="text-xs text-slate-500">This will trigger the agent's payment flow (X402); you'll see a popup to confirm.</p>
        </form>
      </div>
    </section>

    <!-- Log -->
    <section class="rounded-2xl bg-white p-4 shadow">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-lg font-semibold">Console</h2>
        <div class="flex gap-2">
          <button id="clear-log" class="rounded-xl border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-100">Clear</button>
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input id="autoscroll" type="checkbox" class="h-4 w-4 rounded border-slate-300" checked>
            Auto-scroll
          </label>
        </div>
      </div>
      <div id="log" class="h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed"></div>
    </section>
  </div>

  <!-- Payment Modal -->
  <div id="payment-backdrop" class="fixed inset-0 z-40 hidden items-center justify-center bg-black/40 p-4">
    <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
      <div class="mb-4">
        <h3 class="text-xl font-semibold">Payment required</h3>
        <p class="text-sm text-slate-600">A paid tool has been requested. Confirm to continue.</p>
      </div>
      <dl class="mb-4 grid grid-cols-3 gap-2 text-sm">
        <dt class="col-span-1 text-slate-500">Resource</dt>
        <dd id="pay-resource" class="col-span-2 font-medium text-slate-900">—</dd>
        <dt class="col-span-1 text-slate-500">Pay to</dt>
        <dd id="pay-address" class="col-span-2 font-mono text-xs text-slate-900">—</dd>
        <dt class="col-span-1 text-slate-500">Network</dt>
        <dd id="pay-network" class="col-span-2 text-slate-900">—</dd>
        <dt class="col-span-1 text-slate-500">Amount (USD)</dt>
        <dd id="pay-amount" class="col-span-2 text-slate-900">—</dd>
        <dt class="col-span-1 text-slate-500">Confirmation ID</dt>
        <dd id="pay-id" class="col-span-2 font-mono text-xs text-slate-900">—</dd>
      </dl>
      <div class="flex items-center justify-end gap-2">
        <button id="cancel-payment" class="rounded-xl border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-100">Cancel</button>
        <button id="confirm-payment" class="rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-500">Confirm &amp; Pay</button>
      </div>
    </div>
  </div>

  <script>
    // ---------- UI helpers ----------
    const $ = (id) => document.getElementById(id);
    const logEl = $("log");
    const statusDot = $("status-dot");
    const statusText = $("status-text");
    const wsUrlInput = $("ws-url");
    const connectBtn = $("connect-btn");
    const disconnectBtn = $("disconnect-btn");
    const echoForm = $("echo-form");
    const echoInput = $("echo-input");
    const squareForm = $("square-form");
    const squareInput = $("square-input");
    const rawInput = $("raw-input");
    const clearLogBtn = $("clear-log");
    const autoScrollChk = $("autoscroll");

    const paymentBackdrop = $("payment-backdrop");
    const payResource = $("pay-resource");
    const payAddress = $("pay-address");
    const payNetwork = $("pay-network");
    const payAmount = $("pay-amount");
    const payId = $("pay-id");
    const confirmPaymentBtn = $("confirm-payment");
    const cancelPaymentBtn = $("cancel-payment");

    let ws = new WebSocket("/agent");
    let lastPayment = null; // { id, resource, address, network, amount }

    function setStatus(connected) {
      statusDot.className = "inline-block h-3 w-3 rounded-full " + (connected ? "bg-green-500" : "bg-red-500");
      statusText.textContent = connected ? "Connected" : "Disconnected";
    }

    function addLog(kind, text) {
      const row = document.createElement("div");
      row.className = "mb-2 flex gap-2";
      const badge = document.createElement("span");
      badge.className = "shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold " +
        (kind === "client" ? "bg-slate-900 text-white"
         : kind === "server" ? "bg-slate-700 text-white"
         : kind === "result" ? "bg-emerald-600 text-white"
         : kind === "payment" ? "bg-blue-600 text-white"
         : kind === "error" ? "bg-rose-600 text-white"
         : "bg-slate-300 text-slate-900");
      badge.textContent = kind.toUpperCase();

      const msg = document.createElement("pre");
      msg.className = "whitespace-pre-wrap break-words";
      msg.textContent = text;

      row.appendChild(badge);
      row.appendChild(msg);
      logEl.appendChild(row);

      if (autoScrollChk.checked) {
        logEl.scrollTop = logEl.scrollHeight;
      }
    }

    function showPaymentModal(data) {
      lastPayment = data;
      payResource.textContent = data.resource || "—";
      payAddress.textContent = data.address || "—";
      payNetwork.textContent = data.network || "—";
      payAmount.textContent = data.amount || "—";
      payId.textContent = data.id || "—";
      paymentBackdrop.classList.remove("hidden");
      paymentBackdrop.classList.add("flex");
    }

    function hidePaymentModal() {
      paymentBackdrop.classList.add("hidden");
      paymentBackdrop.classList.remove("flex");
    }

    ws.addEventListener("open", () => {
      setStatus(true);
    });

    ws.addEventListener("message", (evt) => {
      const data = typeof evt.data === "string" ? evt.data : "[binary message]";

      try {
        const parsed = JSON.parse(data);
        if (parsed.type?.startsWith("cf_")) return;
        addLog("server", JSON.stringify(parsed, null, 2));
        if (parsed && parsed.type === "payment_required" && Array.isArray(parsed.requirements)) {
        console.log("parsed.requirements", parsed.requirements);
          const p = parsed.requirements[0] || {};
          const amt = (Number(p.maxAmountRequired) / 1e6).toString(); // USD from micro-units
          const details = {
            resource: p.resource || "—",
            address: p.payTo || "—",
            network: p.network || "—",
            amount: amt,
            id: parsed.confirmationId || "—",
          };
          addLog(
            "payment",
            \`Payment prompt for \${details.resource} \n\t$\${details.amount} on \${details.network}\n\tAddress: \${details.address}\n\tConfirmation ID: \${details.id}\`
          );
          showPaymentModal(details);
          return; // handled
        }
      } catch (e) {
      console.error(e);
      }
    });


    ws.addEventListener("error", (e) => {
      addLog("error", "WebSocket error.");
    });

    ws.addEventListener("close", () => {
      setStatus(false);
      addLog("system", "Disconnected.");
    });

    function disconnect() {
      if (ws) {
        ws.close();
        ws = null;
      }
    }

    function send(cmd) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog("error", "Not connected.");
        return;
      }
      addLog("client", cmd);
      ws.send(cmd);
    }

    function sendJSON(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog("error", "Not connected.");
        return;
      }
      // just to make display pretty
      const payload = JSON.stringify(obj, null, 2);
      addLog("client", payload);
      ws.send(payload);
    }

    // ---------- Events ----------
    echoForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = echoInput.value.trim();
      if (!msg) return;
      sendJSON({ type: "echo", message: msg });
    });

    squareForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const n = squareInput.value.trim();
      if (n === "") return;
     sendJSON({ type: "square", number: Number(n) });
    });

    clearLogBtn.addEventListener("click", () => {
      logEl.innerHTML = "";
    });

    confirmPaymentBtn.addEventListener("click", () => {
      if (!lastPayment) return hidePaymentModal();
      sendJSON({ type: "confirm", confirmationId: lastPayment.id });
      hidePaymentModal();
      addLog("payment", \`Sent: confirm \${lastPayment.id}\`);
    });

    cancelPaymentBtn.addEventListener("click", () => {
      if (!lastPayment) return hidePaymentModal();
      sendJSON({ type: "cancel", confirmationId: lastPayment.id });
      hidePaymentModal();
      addLog("payment", \`Sent: cancel \${lastPayment.id}\`);
    });

    // Close modal by clicking outside
    paymentBackdrop.addEventListener("click", (e) => {
      if (e.target === paymentBackdrop) hidePaymentModal();
    });
  </script>
</body>
</html>
`;
