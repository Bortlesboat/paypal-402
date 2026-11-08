import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Order, PayPalAdapter } from "../paypal/types.ts";
import { PayPalError, approvalLink } from "../paypal/types.ts";
import { formatProof, fromCents, toCents, type PaymentOffer } from "../server/protocol.ts";
import { openDb } from "../store/db.ts";
import { DEFAULT_POLICY, evaluatePolicy, validatePolicy, type SpendingPolicy } from "./policy.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS link (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payment_token TEXT NOT NULL,
  customer_id TEXT,
  payer_email TEXT,
  linked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  origin TEXT NOT NULL,
  resource TEXT NOT NULL,
  merchant TEXT NOT NULL,
  kind TEXT NOT NULL,
  calls INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,          -- paid | denied | failed
  method TEXT,                   -- vault | checkout
  order_id TEXT,
  capture_id TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,          -- pending | paid | denied | failed
  via TEXT NOT NULL,             -- owner | paypal
  origin TEXT NOT NULL,
  resource TEXT NOT NULL,
  merchant TEXT NOT NULL,
  offer TEXT NOT NULL,
  reason TEXT NOT NULL,
  approve_url TEXT,
  order_id TEXT,
  proof TEXT,
  ledger_id TEXT
);
CREATE TABLE IF NOT EXISTS credits (
  origin TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

export interface PayRequest {
  url: string;
  offer: PaymentOffer;
  merchant: string;
  resource: string;
}

export interface Receipt {
  ledgerId: string;
  orderId: string;
  captureId?: string;
  amount: string;
  currency: string;
  calls: number;
  method: "vault" | "checkout";
  budgetLeft: string;
}

export type PayResult =
  | { status: "paid"; proof: string; receipt: Receipt }
  | { status: "approval_required"; approvalId: string; via: "owner" | "paypal"; reason: string; approveUrl?: string }
  | { status: "denied"; reason: string }
  | { status: "failed"; reason: string };

export interface WalletOptions {
  paypal: PayPalAdapter;
  /** Public base URL of this wallet service, used for PayPal return URLs. */
  publicUrl: string;
  db?: DatabaseSync | string;
  now?: () => number;
}

/**
 * The buyer side. Holds the vaulted PayPal payment token and the spending policy,
 * and is the only component that can move money. The LLM never sees credentials:
 * it can ask this service to pay an offer, and policy decides.
 */
export class Wallet {
  readonly db: DatabaseSync;
  readonly paypal: PayPalAdapter;
  readonly publicUrl: string;
  #now: () => number;
  #pendingSetup = new Set<string>();

  constructor(opts: WalletOptions) {
    this.paypal = opts.paypal;
    this.publicUrl = opts.publicUrl.replace(/\/$/, "");
    this.db = typeof opts.db === "object" ? opts.db : openDb(opts.db ?? ":memory:", SCHEMA);
    if (typeof opts.db === "object") this.db.exec(SCHEMA);
    this.#now = opts.now ?? (() => Date.now());
  }

  // ---------- policy ----------

  get policy(): SpendingPolicy {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string } | undefined;
    return row ? { ...DEFAULT_POLICY, ...JSON.parse(row.value) } : DEFAULT_POLICY;
  }

  setPolicy(input: unknown): SpendingPolicy {
    const p = validatePolicy({ ...this.policy, ...(input as object) });
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
    return p;
  }

  spentTodayCents(): number {
    const d = new Date(this.#now());
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const r = this.db.prepare("SELECT SUM(amount_cents) c FROM ledger WHERE status = 'paid' AND at >= ?").get(start) as { c: number | null };
    return r.c ?? 0;
  }

  budgetLeft(): string {
    return fromCents(Math.max(0, toCents(this.policy.dailyBudget) - this.spentTodayCents()));
  }

  // ---------- linking PayPal (Vault v3) ----------

  get link(): { paymentToken: string; customerId?: string; payerEmail?: string; linkedAt: number } | undefined {
    const r = this.db.prepare("SELECT payment_token, customer_id, payer_email, linked_at FROM link WHERE id = 1").get() as
      | { payment_token: string; customer_id: string | null; payer_email: string | null; linked_at: number }
      | undefined;
    return r ? { paymentToken: r.payment_token, customerId: r.customer_id ?? undefined, payerEmail: r.payer_email ?? undefined, linkedAt: r.linked_at } : undefined;
  }

  async startLink(): Promise<{ setupTokenId: string; approveUrl?: string }> {
    const st = await this.paypal.createSetupToken({
      returnUrl: `${this.publicUrl}/wallet/link/return`,
      cancelUrl: `${this.publicUrl}/#agent`,
    });
    this.#pendingSetup.add(st.id);
    return { setupTokenId: st.id, approveUrl: st.approveUrl };
  }

  async completeLink(setupTokenId: string) {
    const pt = await this.paypal.createPaymentToken(setupTokenId);
    this.#pendingSetup.delete(setupTokenId);
    this.db
      .prepare(
        "INSERT INTO link (id, payment_token, customer_id, payer_email, linked_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payment_token = excluded.payment_token, customer_id = excluded.customer_id, payer_email = excluded.payer_email, linked_at = excluded.linked_at",
      )
      .run(pt.id, pt.customerId ?? null, pt.payerEmail ?? null, this.#now());
    return this.link!;
  }

  /** The most recent setup token started from this process (redirect flow fallback). */
  lastPendingSetup(): string | undefined {
    return [...this.#pendingSetup].pop();
  }

  unlink() {
    this.db.prepare("DELETE FROM link").run();
  }

  // ---------- paying ----------

  async pay(req: PayRequest): Promise<PayResult> {
    const bad = checkOffer(req.offer);
    if (bad) return { status: "denied", reason: bad };
    let origin: string;
    try {
      origin = new URL(req.url).origin;
    } catch {
      return { status: "denied", reason: "Invalid URL" };
    }
    const decision = evaluatePolicy(this.policy, {
      origin,
      amount: req.offer.amount,
      calls: req.offer.calls,
      spentTodayCents: this.spentTodayCents(),
    });
    if (decision.decision === "deny") {
      this.#ledger(req, origin, "denied", { note: decision.reason });
      return { status: "denied", reason: decision.reason };
    }
    const link = this.link;
    if (decision.decision === "allow" && link) return this.#chargeVault(req, origin, link.paymentToken);

    // Needs a human: either an owner approval (then a vault charge) or a one-time PayPal approval (no vault yet).
    const id = "ap_" + randomBytes(8).toString("hex");
    const reason = decision.decision === "approve" ? decision.reason : "No PayPal account linked; approve this payment on PayPal";
    let via: "owner" | "paypal" = link ? "owner" : "paypal";
    let approveUrl: string | undefined;
    let orderId: string | undefined;
    if (via === "paypal") {
      try {
        const order = await this.paypal.createOrder({
          amount: req.offer.amount,
          currency: req.offer.currency,
          customId: req.offer.id,
          description: `${req.merchant}: ${req.offer.description}`,
          returnUrl: `${this.publicUrl}/wallet/paypal/return`,
          cancelUrl: `${this.publicUrl}/wallet/paypal/cancel`,
          requestId: `p402-${req.offer.id}`,
        });
        orderId = order.id;
        approveUrl = approvalLink(order.links);
      } catch (e) {
        return this.#fail(req, origin, e, "checkout");
      }
    }
    this.db
      .prepare("INSERT INTO approvals (id, at, status, via, origin, resource, merchant, offer, reason, approve_url, order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, this.#now(), "pending", via, origin, req.resource, req.merchant, JSON.stringify({ ...req.offer, url: req.url }), reason, approveUrl ?? null, orderId ?? null);
    return { status: "approval_required", approvalId: id, via, reason, approveUrl };
  }

  async #chargeVault(req: PayRequest, origin: string, vaultId: string): Promise<PayResult> {
    let order: Order;
    try {
      order = await this.paypal.createOrder({
        amount: req.offer.amount,
        currency: req.offer.currency,
        customId: req.offer.id,
        description: `${req.merchant}: ${req.offer.description}`,
        vaultId,
        requestId: `p402-${req.offer.id}`,
      });
      if (order.status === "APPROVED") order = await this.paypal.captureOrder(order.id, `p402-cap-${order.id}`);
    } catch (e) {
      return this.#fail(req, origin, e, "vault");
    }
    return this.#settled(req, origin, order, "vault");
  }

  #settled(req: PayRequest, origin: string, order: Order, method: "vault" | "checkout"): PayResult {
    const cap = order.purchase_units?.[0]?.payments?.captures?.find((c) => c.status === "COMPLETED");
    if (order.status !== "COMPLETED" || !cap) {
      this.#ledger(req, origin, "failed", { method, orderId: order.id, note: `PayPal status ${order.status}` });
      return { status: "failed", reason: `PayPal order ${order.id} is ${order.status}` };
    }
    const ledgerId = this.#ledger(req, origin, "paid", { method, orderId: order.id, captureId: cap.id });
    return {
      status: "paid",
      proof: formatProof({ scheme: "paypal-order", orderId: order.id }),
      receipt: {
        ledgerId,
        orderId: order.id,
        captureId: cap.id,
        amount: req.offer.amount,
        currency: req.offer.currency,
        calls: req.offer.calls,
        method,
        budgetLeft: this.budgetLeft(),
      },
    };
  }

  #fail(req: PayRequest, origin: string, e: unknown, method: "vault" | "checkout"): PayResult {
    const reason = e instanceof PayPalError ? e.message : String(e);
    this.#ledger(req, origin, "failed", { method, note: reason });
    return { status: "failed", reason };
  }

  #ledger(req: PayRequest, origin: string, status: string, x: { method?: string; orderId?: string; captureId?: string; note?: string }) {
    const id = "tx_" + randomBytes(8).toString("hex");
    this.db
      .prepare("INSERT INTO ledger (id, at, origin, resource, merchant, kind, calls, amount_cents, status, method, order_id, capture_id, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, this.#now(), origin, req.resource, req.merchant, req.offer.kind, req.offer.calls, toCents(req.offer.amount), status, x.method ?? null, x.orderId ?? null, x.captureId ?? null, x.note ?? null);
    return id;
  }

  // ---------- approvals ----------

  getApproval(id: string) {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const offer = JSON.parse(String(r.offer));
    return {
      id: String(r.id),
      at: Number(r.at),
      status: String(r.status),
      via: String(r.via),
      origin: String(r.origin),
      resource: String(r.resource),
      merchant: String(r.merchant),
      amount: offer.amount as string,
      calls: offer.calls as number,
      kind: offer.kind as string,
      reason: String(r.reason),
      approveUrl: (r.approve_url as string | null) ?? undefined,
      orderId: (r.order_id as string | null) ?? undefined,
      proof: (r.proof as string | null) ?? undefined,
      ledgerId: (r.ledger_id as string | null) ?? undefined,
    };
  }

  #requestFromApproval(id: string): { req: PayRequest; origin: string } | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const { url, ...offer } = JSON.parse(String(r.offer));
    return { req: { url, offer, merchant: String(r.merchant), resource: String(r.resource) }, origin: String(r.origin) };
  }

  #resolve(id: string, result: PayResult) {
    const status = result.status === "paid" ? "paid" : result.status === "denied" ? "denied" : "failed";
    this.db
      .prepare("UPDATE approvals SET status = ?, proof = ?, ledger_id = ?, reason = CASE WHEN ? IS NULL THEN reason ELSE ? END WHERE id = ?")
      .run(
        status,
        result.status === "paid" ? result.proof : null,
        result.status === "paid" ? result.receipt.ledgerId : null,
        result.status === "paid" ? null : "reason" in result ? result.reason : null,
        result.status === "paid" ? null : "reason" in result ? result.reason : null,
        id,
      );
  }

  /** Owner approves a held payment: re-check the budget, then charge the vault. */
  async approve(id: string): Promise<PayResult> {
    const a = this.getApproval(id);
    if (!a || a.status !== "pending" || a.via !== "owner") return { status: "failed", reason: "No pending owner approval with that id" };
    const ctx = this.#requestFromApproval(id)!;
    const link = this.link;
    let result: PayResult;
    if (!link) result = { status: "failed", reason: "PayPal account is no longer linked" };
    else if (this.spentTodayCents() + toCents(a.amount) > toCents(this.policy.dailyBudget)) result = { status: "denied", reason: "Would exceed daily budget" };
    else result = await this.#chargeVault(ctx.req, ctx.origin, link.paymentToken);
    this.#resolve(id, result);
    return result;
  }

  deny(id: string): boolean {
    const r = this.db.prepare("UPDATE approvals SET status = 'denied', reason = 'Denied by owner' WHERE id = ? AND status = 'pending'").run(id);
    return Number(r.changes) === 1;
  }

  /** PayPal redirected the buyer back after approving a checkout order: capture it. */
  async completeCheckout(orderId: string): Promise<PayResult> {
    const row = this.db.prepare("SELECT id FROM approvals WHERE order_id = ? AND status = 'pending'").get(orderId) as { id: string } | undefined;
    if (!row) return { status: "failed", reason: "Unknown or already settled order" };
    const ctx = this.#requestFromApproval(row.id)!;
    let result: PayResult;
    try {
      let order = await this.paypal.getOrder(orderId);
      if (order.status === "APPROVED") order = await this.paypal.captureOrder(orderId, `p402-cap-${orderId}`);
      result = this.#settled(ctx.req, ctx.origin, order, "checkout");
    } catch (e) {
      result = this.#fail(ctx.req, ctx.origin, e, "checkout");
    }
    this.#resolve(row.id, result);
    return result;
  }

  cancelCheckout(orderId: string) {
    this.db.prepare("UPDATE approvals SET status = 'denied', reason = 'Cancelled on PayPal' WHERE order_id = ? AND status = 'pending'").run(orderId);
  }

  // ---------- prepaid credits (bearer tokens from merchants) ----------

  getCredit(origin: string): { token: string; remaining: number } | undefined {
    return this.db.prepare("SELECT token, remaining FROM credits WHERE origin = ?").get(origin) as { token: string; remaining: number } | undefined;
  }

  setCredit(origin: string, token: string, remaining: number) {
    if (remaining <= 0) {
      this.db.prepare("DELETE FROM credits WHERE origin = ?").run(origin);
      return;
    }
    this.db
      .prepare("INSERT INTO credits (origin, token, remaining, at) VALUES (?,?,?,?) ON CONFLICT(origin) DO UPDATE SET token = excluded.token, remaining = excluded.remaining, at = excluded.at")
      .run(origin, token, remaining, this.#now());
  }

  // ---------- dashboard ----------

  status() {
    const link = this.link;
    return {
      paypalMode: this.paypal.mode,
      linked: Boolean(link),
      payerEmail: link?.payerEmail,
      linkedAt: link?.linkedAt,
      policy: this.policy,
      spentToday: fromCents(this.spentTodayCents()),
      budgetLeft: this.budgetLeft(),
      ledger: this.db.prepare("SELECT id, at, origin, resource, merchant, kind, calls, amount_cents amountCents, status, method, order_id orderId, capture_id captureId, note FROM ledger ORDER BY at DESC LIMIT 30").all(),
      approvals: this.db.prepare("SELECT id FROM approvals ORDER BY at DESC LIMIT 10").all().map((r) => this.getApproval(String((r as { id: string }).id))),
      credits: this.db.prepare("SELECT origin, remaining FROM credits").all(),
    };
  }
}

function checkOffer(o: PaymentOffer | undefined): string | undefined {
  if (!o || typeof o !== "object") return "Missing offer";
  if (o.scheme !== "paypal-order") return "Unsupported payment scheme";
  if (typeof o.id !== "string" || !o.id.startsWith("p402.") || o.id.length > 127) return "Invalid offer id";
  if (typeof o.amount !== "string" || !/^\d{1,6}(\.\d{1,2})?$/.test(o.amount)) return "Invalid amount";
  if (o.currency !== "USD") return "Only USD is supported";
  if (!Number.isInteger(o.calls) || o.calls < 1 || o.calls > 100000) return "Invalid call count";
  if (typeof o.expiresAt === "number" && o.expiresAt * 1000 < Date.now()) return "Offer expired";
  return undefined;
}
