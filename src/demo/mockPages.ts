import express from "express";
import type { MockPayPal } from "../paypal/mock.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f5f7fa;--card:#fff;--ink:#0b1b33;--muted:#5b6b82;--line:#dfe5ee;--brand:#003087;--accent:#0070e0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#121b2e;--ink:#e8eef8;--muted:#93a3bb;--line:#22304a;--brand:#7fb2ff;--accent:#4c9bff}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:380px;width:100%}
.tag{display:inline-block;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 10px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 4px;color:var(--brand)}.amt{font-size:32px;font-weight:650;margin:14px 0}.muted{color:var(--muted)}
button{width:100%;padding:12px;border-radius:99px;border:0;font:inherit;font-weight:600;cursor:pointer;margin-top:10px}
.pay{background:#ffc439;color:#111}.cancel{background:transparent;color:var(--muted);border:1px solid var(--line)}
</style></head><body><main class="card">${body}</main></body></html>`;

/** Local stand-in for the PayPal approval pages. Only mounted when no sandbox credentials are set. */
export function mockPayPalRouter(mock: MockPayPal) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.get("/checkout", (req, res) => {
    const id = String(req.query.token ?? "");
    const s = mock.orders.get(id);
    if (!s) return res.status(404).send(page("Not found", "<h1>Order not found</h1>"));
    const pu = s.order.purchase_units[0];
    res.send(
      page(
        "PayPal (mock)",
        `<span class="tag">PayPal sandbox · mock</span><h1>Approve payment</h1>
<div class="muted">${esc(pu.description ?? "")}</div><div class="amt">$${esc(pu.amount.value)} ${esc(pu.amount.currency_code)}</div>
<div class="muted">Order ${esc(id)} · sb-buyer@personal.example.com</div>
<form method="post" action="checkout/approve"><input type="hidden" name="token" value="${esc(id)}"><button class="pay">Pay with PayPal</button></form>
<form method="get" action="${esc(s.cancelUrl ?? "/")}"><input type="hidden" name="token" value="${esc(id)}"><button class="cancel">Cancel</button></form>`,
      ),
    );
  });

  r.post("/checkout/approve", (req, res) => {
    const id = String(req.body.token ?? "");
    const ret = mock.approveOrder(id);
    if (!ret) return res.status(400).send(page("Error", "<h1>Order cannot be approved</h1>"));
    const u = new URL(ret);
    u.searchParams.set("token", id);
    u.searchParams.set("PayerID", "MOCKPAYER01");
    res.redirect(u.toString());
  });

  r.get("/vault", (req, res) => {
    const id = String(req.query.approval_token_id ?? "");
    const st = mock.setupTokens.get(id);
    if (!st) return res.status(404).send(page("Not found", "<h1>Setup token not found</h1>"));
    res.send(
      page(
        "PayPal (mock)",
        `<span class="tag">PayPal sandbox · mock</span><h1>Save PayPal for agent payments</h1>
<p class="muted">PayPal 402 will be able to charge this account for API calls within the limits you set. You can unlink at any time.</p>
<div class="muted">sb-buyer@personal.example.com</div>
<form method="post" action="vault/approve"><input type="hidden" name="id" value="${esc(id)}"><button class="pay">Agree and link</button></form>
<form method="get" action="${esc(st.cancelUrl)}"><button class="cancel">Cancel</button></form>`,
      ),
    );
  });

  r.post("/vault/approve", (req, res) => {
    const id = String(req.body.id ?? "");
    const ret = mock.approveSetupToken(id);
    if (!ret) return res.status(400).send(page("Error", "<h1>Setup token cannot be approved</h1>"));
    const u = new URL(ret);
    u.searchParams.set("approval_token_id", id);
    u.searchParams.set("approval_session_id", "MOCKSESSION");
    res.redirect(u.toString());
  });

  return r;
}
