const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

let config = {};
let state = null;
let policyDirty = false;

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("#agent").classList.toggle("hidden", name !== "agent");
  $("#merchant").classList.toggle("hidden", name !== "merchant");
  history.replaceState(null, "", `#${name}`);
}
document.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
showTab(location.hash === "#merchant" ? "merchant" : "agent");

// ---------- api ----------
async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---------- wallet ----------
function renderLink(w) {
  const box = $("#link-box");
  $("#link-state").textContent = w.linked ? "" : "Not linked";
  if (w.linked) {
    box.innerHTML = `<div class="linked"><span>PayPal <b>${esc(w.payerEmail || "linked")}</b></span><button class="link" id="unlink">Unlink</button></div>`;
    $("#unlink").onclick = async () => { await api("/wallet/unlink", { method: "POST" }); refresh(); };
    return;
  }
  if (box.dataset.state === "unlinked") return;
  box.dataset.state = "unlinked";
  box.innerHTML = `<div id="paypal-sdk"></div><button class="btn paypal" id="link">Link PayPal</button>`;
  $("#link").onclick = async () => {
    const { approveUrl } = await api("/wallet/link", { method: "POST" });
    if (approveUrl) location.href = approveUrl;
  };
  if (config.clientId) mountSdkButton();
}

// Real sandbox: PayPal JS SDK "save PayPal" button (Vault v3 setup token). Redirect button stays as fallback.
function mountSdkButton() {
  const s = document.createElement("script");
  s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&components=buttons`;
  s.onload = () => {
    if (!window.paypal?.Buttons) return;
    window.paypal.Buttons({
      style: { layout: "horizontal", label: "paypal", tagline: false, height: 40 },
      createVaultSetupToken: async () => (await api("/wallet/link", { method: "POST" })).setupTokenId,
      onApprove: async ({ vaultSetupToken }) => {
        await api("/wallet/link/complete", { method: "POST", body: JSON.stringify({ setupTokenId: vaultSetupToken }) });
        refresh();
      },
      onError: (e) => console.error("PayPal SDK", e),
    }).render("#paypal-sdk").then(() => $("#link")?.classList.add("hidden")).catch(() => {});
  };
  document.head.appendChild(s);
}

function renderWallet(w) {
  renderLink(w);
  const budget = Math.round(Number(w.policy.dailyBudget) * 100);
  const spent = Math.round(Number(w.spentToday) * 100);
  $("#budget-left").textContent = `$${w.budgetLeft}`;
  $("#budget-bar").style.width = `${budget ? Math.min(100, (spent / budget) * 100) : 0}%`;
  $("#budget-caption").textContent = `$${w.spentToday} of $${w.policy.dailyBudget} spent today`;

  if (!policyDirty) {
    const f = $("#policy");
    f.dailyBudget.value = w.policy.dailyBudget;
    f.perCallCap.value = w.policy.perCallCap;
    f.approvalAbove.value = w.policy.approvalAbove;
    f.allowedOrigins.value = w.policy.allowedOrigins.join("\n");
    f.paused.checked = w.policy.paused;
  }

  const pending = w.approvals.filter((a) => a.status === "pending");
  $("#approvals-card").classList.toggle("hidden", pending.length === 0);
  $("#approvals").innerHTML = pending.map((a) => `<li>
      <span>${esc(a.merchant)} · ${a.kind === "bundle" ? `${a.calls} calls` : "1 call"}</span><span class="amt">$${esc(a.amount)}</span>
      <span class="sub">${esc(a.reason)}</span>
      <span class="sub">${approvalActions(a)}</span></li>`).join("");
  bindApprovalButtons($("#approvals"));

  $("#ledger").innerHTML = w.ledger.map((t) => `<li>
      <span>${esc(t.merchant)} <span class="status ${esc(t.status)}">${esc(t.status)}</span></span><span class="amt">${usd(t.amountCents)}</span>
      <span class="sub">${esc(t.resource)} · ${t.kind === "bundle" ? `${t.calls} calls` : "per call"} · ${time(t.at)}</span>
      ${t.orderId ? `<span class="sub mono">order ${esc(t.orderId)}${t.captureId ? ` · capture ${esc(t.captureId)}` : ""}</span>` : ""}
      ${t.note ? `<span class="sub">${esc(t.note)}</span>` : ""}</li>`).join("");
}

function approvalActions(a) {
  if (a.via === "paypal") return `<a class="btn small paypal" style="width:auto;display:inline-block;text-decoration:none" href="${esc(a.approveUrl)}">Approve on PayPal</a>`;
  return `<button class="btn small ok" data-approve="${esc(a.id)}">Approve</button> <button class="btn small" data-deny="${esc(a.id)}">Deny</button>`;
}

function bindApprovalButtons(root) {
  root.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    await api(`/wallet/approvals/${b.dataset.approve}/approve`, { method: "POST" }).catch((e) => alert(e.message));
    refresh();
  }));
  root.querySelectorAll("[data-deny]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    await api(`/wallet/approvals/${b.dataset.deny}/deny`, { method: "POST" });
    refresh();
  }));
}

$("#policy").addEventListener("input", () => (policyDirty = true));
$("#policy").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("/wallet/policy", {
      method: "PUT",
      body: JSON.stringify({
        dailyBudget: f.dailyBudget.value,
        perCallCap: f.perCallCap.value,
        approvalAbove: f.approvalAbove.value,
        allowedOrigins: f.allowedOrigins.value.split(/\s+/).filter(Boolean),
        paused: f.paused.checked,
      }),
    });
    policyDirty = false;
    refresh();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- merchant ----------
function renderMerchant(m, d) {
  $("#k-revenue").textContent = `$${m.revenue}`;
  $("#k-captures").textContent = m.captures;
  $("#k-calls").textContent = m.calls;
  $("#k-credits").textContent = m.creditsOutstanding;
  $("#m-name").textContent = `${d.merchant} · ${d.bundle ? `bundle $${d.bundle.amount} / ${d.bundle.calls} calls` : ""}`;
  const counts = Object.fromEntries(m.byRoute.map((r) => [r.route, r.calls]));
  $("#routes").innerHTML = d.routes.map((r) => `<tr><td class="mono">${esc(r.route)}</td><td>$${esc(r.price)}</td><td class="num">${counts[r.route] || 0}</td></tr>`).join("");
  $("#payments").innerHTML = m.payments.map((p) => `<tr>
      <td>${time(p.at)}</td><td class="mono">${esc(p.orderId)}</td><td class="mono">${esc(p.captureId)}</td>
      <td>${p.kind === "bundle" ? "Bundle" : "Per call"}</td><td class="mono">${esc(p.route)}</td><td class="num">${usd(p.amountCents)}</td></tr>`).join("");
}

// ---------- polling ----------
async function refresh() {
  try {
    state = await api("/dashboard/state");
    renderWallet(state.wallet);
    renderMerchant(state.merchant, state.discovery);
  } catch (e) {
    console.warn(e);
  }
}

// ---------- agent run ----------
const tl = $("#timeline");
function add(cls, dot, title, sub = "", extra = "") {
  const li = document.createElement("li");
  li.className = `ev ${cls}`;
  li.innerHTML = `<span class="dot">${dot}</span><div class="ev-body"><div class="ev-title">${title}</div>${sub ? `<div class="ev-sub">${sub}</div>` : ""}${extra}</div>`;
  tl.appendChild(li);
  li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return li;
}

const approvalNodes = new Map();
function onEvent(e) {
  switch (e.type) {
    case "step": return add("", "·", esc(e.text));
    case "tool": return add("", "→", `<span class="mono">${esc(e.name)}</span>`, esc(e.input?.url || e.input?.origin || ""));
    case "http": return e.status === 402 ? null : add(e.status < 300 ? "ok" : "bad", e.status, `GET ${esc(short(e.url))}`, e.paidWith ? `paid with ${esc(e.paidWith)}` : "");
    case "payment_required":
      return add("e402", "402", "Payment Required", esc(short(e.url)),
        `<div class="offers">${e.offers.map((o) => `<span class="offer">${o.kind === "bundle" ? `$${esc(o.amount)} for ${o.calls} calls` : `$${esc(o.amount)} per call`}</span>`).join("")}</div>`);
    case "policy":
      if (e.decision === "allowed") return add("ok", "✓", "Within policy");
      if (e.decision === "approval_required") return null;
      return add("bad", "!", `Policy: ${esc(e.decision)}`, esc(e.reason));
    case "approval": {
      if (e.status === "pending") {
        const node = add("approval", "?", "Needs your approval", esc(e.reason),
          `<div class="approve-box"><span class="amt"></span><span class="muted small">${e.via === "paypal" ? "No PayPal linked yet: approve this one payment on PayPal." : "Charge your linked PayPal?"}</span>
           <span class="actions">${e.via === "paypal" ? `<a class="btn small paypal" style="width:auto;text-decoration:none" href="${esc(e.approveUrl)}" target="_blank" rel="noopener">Approve on PayPal</a>` : `<button class="btn small ok" data-approve="${esc(e.approvalId)}">Approve</button><button class="btn small" data-deny="${esc(e.approvalId)}">Deny</button>`}</span></div>`);
        const a = state?.wallet.approvals.find((x) => x.id === e.approvalId);
        bindApprovalButtons(node);
        approvalNodes.set(e.approvalId, node);
        refresh().then(() => {
          const ap = state?.wallet.approvals.find((x) => x.id === e.approvalId) || a;
          if (ap) node.querySelector(".amt").textContent = `$${ap.amount}`;
        });
        return node;
      }
      approvalNodes.get(e.approvalId)?.querySelector(".approve-box")?.remove();
      return add(e.status === "paid" ? "ok" : "bad", e.status === "paid" ? "✓" : "✕", e.status === "paid" ? "Approved" : `Approval ${esc(e.status)}`);
    }
    case "paid":
      refresh();
      return add("paid", "$", `Paid $${esc(e.amount)} with PayPal${e.calls > 1 ? ` · ${e.calls} calls` : ""}`,
        `<span class="mono">order ${esc(e.orderId)}${e.captureId ? ` · capture ${esc(e.captureId)}` : ""}</span> · $${esc(e.budgetLeft)} left today`);
    case "receipt":
      return e.receipt.scheme === "paypal-credit" ? add("ok", "◎", "Used prepaid credit", `${e.receipt.creditsRemaining} left`) : null;
    case "error": return add("bad", "!", "Error", esc(e.text));
  }
}

function showAnswer(d) {
  const orders = d.receipts.filter((r) => r.orderId);
  const li = document.createElement("li");
  li.innerHTML = `<div class="answer">${esc(d.answer)}<div class="answer-foot"><span>Spent $${esc(d.spent)}</span><span>${orders.length} PayPal capture${orders.length === 1 ? "" : "s"}</span><span>$${esc(d.budgetLeft)} left today</span><span>${esc(d.provider)}</span></div></div>`;
  tl.appendChild(li);
  li.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

document.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => ($("#task").value = b.dataset.preset)));
$("#task-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const run = $("#run");
  run.disabled = true;
  run.textContent = "Running";
  tl.innerHTML = "";
  approvalNodes.clear();
  try {
    const res = await fetch("/agent/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: $("#task").value }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] || "null");
        if (name === "event") onEvent(data);
        else if (name === "done") showAnswer(data);
        else if (name === "failed") add("bad", "!", "Run failed", esc(data.message));
      }
    }
  } finally {
    run.disabled = false;
    run.textContent = "Run agent";
    refresh();
  }
});

// ---------- boot ----------
config = await api("/dashboard/config");
const mode = $("#mode");
mode.textContent = config.paypalMode === "mock" ? "Mock PayPal" : config.paypalMode === "sandbox" ? "PayPal Sandbox" : "PayPal Live";
mode.classList.toggle("live", config.paypalMode !== "mock");
$("#model").textContent = config.provider;
await refresh();
setInterval(refresh, 2500);
