import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { MockPayPal } from "../src/paypal/mock.ts";
import { Paywall } from "../src/server/paywall.ts";
import { PROTOCOL, type PaymentOffer } from "../src/server/protocol.ts";

const ROUTE = "GET /api/fees/recommend";
const OTHER = "GET /api/mempool/summary";
const SECRET = "test-secret-0123456789";

let paypal: MockPayPal;
let paywall: Paywall;

beforeEach(() => {
  paypal = new MockPayPal();
  paypal.paymentTokens.set("tok1", { customerId: "C1", email: "buyer@example.com" });
  paywall = new Paywall({ paypal, secret: SECRET, merchant: { name: "Fee Oracle" }, bundle: { amount: "1.00", calls: 3 } });
});

async function offers(route = ROUTE, price = "0.05") {
  const d = await paywall.authorize(route, price, "fees", undefined);
  assert.equal(d.ok, false);
  return (d as { body: { accepts: PaymentOffer[] } }).body.accepts;
}

async function vaultPay(offer: PaymentOffer, amount = offer.amount) {
  const o = await paypal.createOrder({ amount, currency: "USD", customId: offer.id, vaultId: "tok1" });
  return o.id;
}

describe("402 response", () => {
  it("returns payment requirements with per-call and bundle offers", async () => {
    const d = await paywall.authorize(ROUTE, "0.05", "fees", undefined);
    assert.equal(d.ok, false);
    if (d.ok) return;
    assert.equal(d.status, 402);
    assert.equal(d.body.protocol, PROTOCOL);
    assert.equal(d.body.error, "payment_required");
    assert.equal(d.body.resource, ROUTE);
    assert.equal(d.body.header, "X-PAYMENT");
    const [perCall, bundle] = d.body.accepts;
    assert.deepEqual([perCall.kind, perCall.amount, perCall.calls, perCall.currency], ["per_call", "0.05", 1, "USD"]);
    assert.deepEqual([bundle.kind, bundle.amount, bundle.calls], ["bundle", "1.00", 3]);
    assert.match(perCall.id, /^p402\.c\./);
    assert.ok(perCall.id.length <= 127, "fits PayPal custom_id");
    assert.ok(perCall.expiresAt > Date.now() / 1000);
  });

  it("rejects malformed payment headers", async () => {
    const d = await paywall.authorize(ROUTE, "0.05", "fees", "bitcoin abc");
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.body.error, "malformed_payment_header");
  });
});

describe("order verification", () => {
  it("accepts a captured order bound to the offer and returns a receipt", async () => {
    const [offer] = await offers();
    const orderId = await vaultPay(offer);
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.receipt.orderId, orderId);
    assert.match(d.receipt.captureId!, /^CAP-/);
    assert.equal(d.receipt.amount, "0.05");
    const s = paywall.stats();
    assert.equal(s.revenue, "0.05");
    assert.equal(s.captures, 1);
  });

  it("rejects a replayed order id", async () => {
    const [offer] = await offers();
    const orderId = await vaultPay(offer);
    assert.equal((await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`)).ok, true);
    const again = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.status, 409);
    assert.equal(!again.ok && again.body.error, "order_already_used");
  });

  it("allows exactly one redemption under concurrent replays", async () => {
    const [offer] = await offers();
    const orderId = await vaultPay(offer);
    const results = await Promise.all(Array.from({ length: 5 }, () => paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`)));
    assert.equal(results.filter((r) => r.ok).length, 1);
  });

  it("rejects an order paid for a different route", async () => {
    const [offer] = await offers(OTHER, "0.05");
    const orderId = await vaultPay(offer);
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(!d.ok && d.body.error, "offer_mismatch");
  });

  it("rejects an order for less than the offer amount", async () => {
    const [offer] = await offers();
    const orderId = await vaultPay(offer, "0.01");
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.body.error, "offer_mismatch");
  });

  it("rejects orders that are not PayPal 402 orders", async () => {
    const o = await paypal.createOrder({ amount: "0.05", currency: "USD", customId: "invoice-123", vaultId: "tok1" });
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${o.id}`);
    assert.equal(!d.ok && d.body.error, "not_a_paypal402_order");
  });

  it("rejects unknown orders", async () => {
    const d = await paywall.authorize(ROUTE, "0.05", "fees", "paypal-order NOPE12345");
    assert.equal(!d.ok && d.body.error, "order_not_found");
  });

  it("rejects orders the buyer has not approved", async () => {
    const [offer] = await offers();
    const o = await paypal.createOrder({ amount: "0.05", currency: "USD", customId: offer.id, returnUrl: "http://x/r", cancelUrl: "http://x/c" });
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${o.id}`);
    assert.equal(!d.ok && d.body.error, "order_not_completed");
  });

  it("captures approved-but-uncaptured orders server-side", async () => {
    const [offer] = await offers();
    const o = await paypal.createOrder({ amount: "0.05", currency: "USD", customId: offer.id, returnUrl: "http://x/r", cancelUrl: "http://x/c" });
    paypal.approveOrder(o.id);
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${o.id}`);
    assert.equal(d.ok, true);
    assert.equal((await paypal.getOrder(o.id)).status, "COMPLETED");
  });

  it("rejects orders made against an expired offer", async () => {
    let now = Date.now();
    paywall = new Paywall({ paypal, secret: SECRET, merchant: { name: "Fee Oracle" }, offerTtlSeconds: 60, now: () => now });
    const [offer] = await offers();
    const orderId = await vaultPay(offer);
    now += 121_000;
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(!d.ok && d.body.error, "offer_expired");
  });

  it("rejects offers signed by a different merchant secret", async () => {
    const other = new Paywall({ paypal, secret: "another-secret-987654321", merchant: { name: "Fee Oracle" } });
    const d0 = await other.authorize(ROUTE, "0.05", "fees", undefined);
    const offer = (d0 as { body: { accepts: PaymentOffer[] } }).body.accepts[0];
    const orderId = await vaultPay(offer);
    const d = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(!d.ok && d.body.error, "offer_mismatch");
  });
});

describe("prepaid credits", () => {
  it("issues a credit token for a bundle and decrements it on each call", async () => {
    const [, bundle] = await offers();
    const orderId = await vaultPay(bundle);
    const first = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-order ${orderId}`);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.receipt.creditsRemaining, 2);
    const token = first.receipt.creditToken!;
    const second = await paywall.authorize(OTHER, "0.03", "mempool", `paypal-credit ${token}`);
    assert.equal(second.ok && second.receipt.creditsRemaining, 1);
    const third = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-credit ${token}`);
    assert.equal(third.ok && third.receipt.creditsRemaining, 0);
    const fourth = await paywall.authorize(ROUTE, "0.05", "fees", `paypal-credit ${token}`);
    assert.equal(!fourth.ok && fourth.body.error, "credits_exhausted");
    assert.equal(paywall.stats().calls, 3);
  });

  it("rejects unknown credit tokens", async () => {
    const d = await paywall.authorize(ROUTE, "0.05", "fees", "paypal-credit cr_doesnotexist");
    assert.equal(!d.ok && d.body.error, "unknown_credit_token");
  });
});
