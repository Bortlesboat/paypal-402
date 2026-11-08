import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Order, PayPalAdapter } from "../paypal/types.ts";
import { PayPalError } from "../paypal/types.ts";
import { isUniqueViolation, openDb } from "../store/db.ts";
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PROTOCOL,
  encodeReceipt,
  fromCents,
  parseProof,
  toCents,
  type OfferKind,
  type PaymentOffer,
  type PaymentReceipt,
  type PaymentRequired,
} from "./protocol.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  order_id TEXT PRIMARY KEY,
  capture_id TEXT,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payer TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credits (
  token TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES payments(order_id),
  total INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route TEXT NOT NULL,
  scheme TEXT NOT NULL,
  ref TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

export interface PaywallOptions {
  paypal: PayPalAdapter;
  merchant: { name: string; payeeMerchantId?: string };
  /** HMAC key that binds offers to routes and prices. Keep it private and stable. */
  secret: string;
  db?: DatabaseSync | string;
  currency?: string;
  /** Optional prepaid bundle, valid on every route behind this paywall. */
  bundle?: { amount: string; calls: number };
  offerTtlSeconds?: number;
  /** Capture orders that arrive APPROVED but not yet captured. Default true. */
  captureApproved?: boolean;
  now?: () => number;
}

export interface PricedRoute {
  route: string;
  price: string;
  description: string;
}

type Decision =
  | { ok: true; receipt: PaymentReceipt }
  | { ok: false; status: number; body: PaymentRequired };

export class Paywall {
  readonly db: DatabaseSync;
  readonly opts: Required<Pick<PaywallOptions, "currency" | "offerTtlSeconds" | "captureApproved">> & PaywallOptions;
  readonly routes: PricedRoute[] = [];
  #now: () => number;

  constructor(opts: PaywallOptions) {
    if (!opts.secret || opts.secret.length < 16) throw new Error("Paywall secret must be at least 16 characters");
    this.opts = { currency: "USD", offerTtlSeconds: 900, captureApproved: true, ...opts };
    this.db = typeof opts.db === "object" ? opts.db : openDb(opts.db ?? ":memory:", SCHEMA);
    if (typeof opts.db === "object") this.db.exec(SCHEMA);
    this.#now = opts.now ?? (() => Date.now());
  }

  // ---------- offers ----------

  #sign(kind: OfferKind, scope: string, amount: string, exp: number, nonce: string): string {
    return createHmac("sha256", this.opts.secret)
      .update([PROTOCOL, kind, scope, toCents(amount), this.opts.currency, exp, nonce].join("|"))
      .digest("base64url")
      .slice(0, 22);
  }

  #offer(kind: OfferKind, scope: string, amount: string, calls: number, description: string): PaymentOffer {
    const exp = Math.floor(this.#now() / 1000) + this.opts.offerTtlSeconds;
    const nonce = randomBytes(6).toString("base64url");
    const k = kind === "per_call" ? "c" : "b";
    const id = `p402.${k}.${exp.toString(36)}.${nonce}.${this.#sign(kind, scope, amount, exp, nonce)}`;
    return { id, scheme: "paypal-order", kind, amount, currency: this.opts.currency, calls, expiresAt: exp, description };
  }

  /** Returns the offer kind if the custom_id is a valid, unexpired offer for this route and amount. */
  #checkOffer(customId: string | undefined, route: string, amount: string): OfferKind | string {
    const parts = (customId ?? "").split(".");
    if (parts.length !== 5 || parts[0] !== "p402") return "not_a_paypal402_order";
    const [, k, exp36, nonce, sig] = parts;
    const kind: OfferKind = k === "b" ? "bundle" : "per_call";
    const exp = parseInt(exp36, 36);
    const scope = kind === "bundle" ? this.#bundleScope() : route;
    const expected = this.#sign(kind, scope, amount, exp, nonce);
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "offer_mismatch";
    // Offers expire for new orders; an order created in time gets one more TTL window to be redeemed.
    if (Math.floor(this.#now() / 1000) > exp + this.opts.offerTtlSeconds) return "offer_expired";
    return kind;
  }

  #bundleScope() {
    return `bundle:${this.opts.merchant.name}`;
  }

  paymentRequired(route: string, price: string, description: string, error = "payment_required", message?: string): PaymentRequired {
    const accepts = [this.#offer("per_call", route, price, 1, description)];
    const b = this.opts.bundle;
    if (b) accepts.push(this.#offer("bundle", this.#bundleScope(), b.amount, b.calls, `${b.calls} calls to any ${this.opts.merchant.name} endpoint`));
    return {
      protocol: PROTOCOL,
      error,
      ...(message ? { message } : {}),
      resource: route,
      merchant: { name: this.opts.merchant.name, ...(this.opts.merchant.payeeMerchantId ? { payee: this.opts.merchant.payeeMerchantId } : {}) },
      accepts,
      header: "X-PAYMENT",
      formats: { order: "paypal-order <PayPal order id>", credit: "paypal-credit <credit token>" },
    };
  }

  // ---------- verification ----------

  async authorize(route: string, price: string, description: string, proofHeader: string | undefined): Promise<Decision> {
    const deny = (status: number, error: string, message?: string): Decision => ({
      ok: false,
      status,
      body: this.paymentRequired(route, price, description, error, message),
    });
    const proof = parseProof(proofHeader);
    if (!proofHeader) return deny(402, "payment_required");
    if (!proof) return deny(402, "malformed_payment_header");

    if (proof.scheme === "paypal-credit") {
      const r = this.db.prepare("UPDATE credits SET remaining = remaining - 1 WHERE token = ? AND remaining > 0").run(proof.token);
      if (Number(r.changes) !== 1) {
        const exists = this.db.prepare("SELECT 1 FROM credits WHERE token = ?").get(proof.token);
        return deny(402, exists ? "credits_exhausted" : "unknown_credit_token");
      }
      const row = this.db.prepare("SELECT remaining FROM credits WHERE token = ?").get(proof.token) as { remaining: number };
      this.#logCall(route, "credit", proof.token);
      return { ok: true, receipt: { scheme: "paypal-credit", creditToken: proof.token, creditsRemaining: row.remaining } };
    }

    // paypal-order: never trust the client, ask PayPal.
    let order: Order;
    try {
      order = await this.opts.paypal.getOrder(proof.orderId);
    } catch (e) {
      if (e instanceof PayPalError && e.status === 404) return deny(402, "order_not_found");
      throw e;
    }
    const used = this.db.prepare("SELECT 1 FROM payments WHERE order_id = ?").get(order.id);
    if (used) return deny(409, "order_already_used");

    const pu = order.purchase_units?.[0];
    if (!pu) return deny(402, "order_invalid");
    const offerAmount = pu.amount?.value ?? "0";
    const kind = this.#checkOffer(pu.custom_id, route, offerAmount);
    if (kind !== "per_call" && kind !== "bundle") return deny(402, kind);
    const expectedCents = kind === "bundle" ? toCents(this.opts.bundle?.amount ?? "-1") : toCents(price);
    if (toCents(offerAmount) !== expectedCents || pu.amount.currency_code !== this.opts.currency) return deny(402, "amount_mismatch");
    const payee = this.opts.merchant.payeeMerchantId;
    if (payee && pu.payee?.merchant_id && pu.payee.merchant_id !== payee) return deny(402, "wrong_payee");

    if (order.status === "APPROVED" && this.opts.captureApproved) {
      order = await this.opts.paypal.captureOrder(order.id, `p402-capture-${order.id}`);
    }
    if (order.status !== "COMPLETED") return deny(402, "order_not_completed", `PayPal status ${order.status}`);
    const capture = order.purchase_units[0].payments?.captures?.find((c) => c.status === "COMPLETED");
    if (!capture || toCents(capture.amount.value) !== expectedCents || capture.amount.currency_code !== this.opts.currency) {
      return deny(402, "capture_not_completed");
    }

    // Replay protection: the primary key makes redemption atomic even under concurrent retries.
    try {
      this.db
        .prepare("INSERT INTO payments (order_id, capture_id, kind, route, amount_cents, currency, payer, at) VALUES (?,?,?,?,?,?,?,?)")
        .run(order.id, capture.id, kind, route, expectedCents, this.opts.currency, order.payment_source?.paypal?.email_address ?? null, this.#now());
    } catch (e) {
      if (isUniqueViolation(e)) return deny(409, "order_already_used");
      throw e;
    }

    const receipt: PaymentReceipt = {
      scheme: "paypal-order",
      orderId: order.id,
      captureId: capture.id,
      amount: fromCents(expectedCents),
      currency: this.opts.currency,
    };
    if (kind === "bundle") {
      const calls = this.opts.bundle!.calls;
      const token = "cr_" + randomBytes(18).toString("base64url");
      this.db.prepare("INSERT INTO credits (token, order_id, total, remaining, at) VALUES (?,?,?,?,?)").run(token, order.id, calls, calls - 1, this.#now());
      receipt.creditToken = token;
      receipt.creditsRemaining = calls - 1;
    }
    this.#logCall(route, "order", order.id);
    return { ok: true, receipt };
  }

  #logCall(route: string, scheme: string, ref: string) {
    this.db.prepare("INSERT INTO calls (route, scheme, ref, at) VALUES (?,?,?,?)").run(route, scheme, ref, this.#now());
  }

  // ---------- express ----------

  /** Express middleware: `app.get("/api/x", paywall.charge({ price: "0.05" }), handler)`. */
  charge(opts: { price: string; description?: string }): RequestHandler {
    const description = opts.description ?? "API call";
    let registered = false;
    return async (req: Request, res: Response, next: NextFunction) => {
      const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
      if (!registered) {
        registered = true;
        if (!this.routes.some((r) => r.route === route)) this.routes.push({ route, price: opts.price, description });
      }
      try {
        const d = await this.authorize(route, opts.price, description, req.get(PAYMENT_HEADER));
        if (!d.ok) {
          res.status(d.status).set("X-Payment-Protocol", PROTOCOL).json(d.body);
          return;
        }
        res.set(PAYMENT_RESPONSE_HEADER, encodeReceipt(d.receipt));
        res.set("Access-Control-Expose-Headers", PAYMENT_RESPONSE_HEADER);
        (req as Request & { payment?: PaymentReceipt }).payment = d.receipt;
        next();
      } catch (e) {
        next(e);
      }
    };
  }

  /** Declare a priced route up front so discovery lists it before the first call. */
  register(route: string, price: string, description: string) {
    if (!this.routes.some((r) => r.route === route)) this.routes.push({ route, price, description });
  }

  discovery() {
    return {
      protocol: PROTOCOL,
      merchant: this.opts.merchant.name,
      currency: this.opts.currency,
      routes: this.routes,
      bundle: this.opts.bundle ?? null,
    };
  }

  stats() {
    const one = <T>(sql: string) => this.db.prepare(sql).get() as T;
    const revenue = one<{ c: number | null; n: number }>("SELECT SUM(amount_cents) c, COUNT(*) n FROM payments");
    const calls = one<{ n: number }>("SELECT COUNT(*) n FROM calls");
    const credits = one<{ r: number | null }>("SELECT SUM(remaining) r FROM credits");
    return {
      revenue: fromCents(revenue.c ?? 0),
      captures: revenue.n,
      calls: calls.n,
      creditsOutstanding: credits.r ?? 0,
      payments: this.db.prepare("SELECT order_id orderId, capture_id captureId, kind, route, amount_cents amountCents, payer, at FROM payments ORDER BY at DESC LIMIT 25").all(),
      recentCalls: this.db.prepare("SELECT route, scheme, ref, at FROM calls ORDER BY id DESC LIMIT 25").all(),
      byRoute: this.db.prepare("SELECT route, COUNT(*) calls FROM calls GROUP BY route ORDER BY calls DESC").all(),
    };
  }
}
