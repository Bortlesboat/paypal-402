import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { MockPayPal } from "../src/paypal/mock.ts";
import { Paywall } from "../src/server/paywall.ts";
import type { PaymentOffer } from "../src/server/protocol.ts";
import { evaluatePolicy, validatePolicy, DEFAULT_POLICY } from "../src/wallet/policy.ts";
import { Wallet } from "../src/wallet/wallet.ts";

const API = "http://api.test";

describe("policy", () => {
  const p = { ...DEFAULT_POLICY, allowedOrigins: [API] };
  const ask = { origin: API, amount: "0.05", calls: 1, spentTodayCents: 0 };

  it("allows a small payment to an allowed merchant", () => {
    assert.deepEqual(evaluatePolicy(p, ask), { decision: "allow" });
  });
  it("denies merchants that are not allowed", () => {
    assert.equal(evaluatePolicy(p, { ...ask, origin: "http://evil.test" }).decision, "deny");
  });
  it("denies a unit price above the per-call cap", () => {
    assert.equal(evaluatePolicy(p, { ...ask, amount: "0.25" }).decision, "deny");
  });
  it("judges bundles by unit price", () => {
    assert.equal(evaluatePolicy({ ...p, approvalAbove: "5.00" }, { ...ask, amount: "1.00", calls: 50 }).decision, "allow");
  });
  it("holds payments above the approval threshold", () => {
    assert.equal(evaluatePolicy(p, { ...ask, amount: "1.00", calls: 50 }).decision, "approve");
  });
  it("denies payments that would exceed the daily budget", () => {
    assert.equal(evaluatePolicy(p, { ...ask, spentTodayCents: 498 }).decision, "deny");
  });
  it("denies everything when paused", () => {
    assert.equal(evaluatePolicy({ ...p, paused: true }, ask).decision, "deny");
  });
  it("validates and normalizes policy input", () => {
    const v = validatePolicy({ dailyBudget: "3", allowedOrigins: ["http://api.test/path"] });
    assert.equal(v.dailyBudget, "3.00");
    assert.deepEqual(v.allowedOrigins, [API]);
    assert.throws(() => validatePolicy({ dailyBudget: "-1" }));
  });
});

describe("wallet", () => {
  let paypal: MockPayPal;
  let wallet: Wallet;
  let paywall: Paywall;

  beforeEach(() => {
    paypal = new MockPayPal("http://wallet.test");
    wallet = new Wallet({ paypal, publicUrl: "http://wallet.test" });
    wallet.setPolicy({ allowedOrigins: [API] });
    paywall = new Paywall({ paypal, secret: "wallet-test-secret-123", merchant: { name: "Fee Oracle" }, bundle: { amount: "1.00", calls: 50 } });
  });

  async function offer(kind: "per_call" | "bundle" = "per_call"): Promise<PaymentOffer> {
    const d = await paywall.authorize("GET /x", "0.05", "x", undefined);
    return (d as { body: { accepts: PaymentOffer[] } }).body.accepts.find((o) => o.kind === kind)!;
  }

  async function link() {
    const { setupTokenId, approveUrl } = await wallet.startLink();
    assert.match(approveUrl!, /mock-paypal\/vault/);
    paypal.approveSetupToken(setupTokenId);
    return wallet.completeLink(setupTokenId);
  }

  it("links PayPal through a Vault setup token", async () => {
    const l = await link();
    assert.ok(l.paymentToken);
    assert.equal(wallet.status().linked, true);
  });

  it("refuses to vault an unapproved setup token", async () => {
    const { setupTokenId } = await wallet.startLink();
    await assert.rejects(wallet.completeLink(setupTokenId));
  });

  it("pays an allowed offer with the vaulted token and the merchant accepts it", async () => {
    await link();
    const r = await wallet.pay({ url: `${API}/x`, offer: await offer(), merchant: "Fee Oracle", resource: "GET /x" });
    assert.equal(r.status, "paid");
    if (r.status !== "paid") return;
    assert.match(r.proof, /^paypal-order /);
    assert.equal(r.receipt.method, "vault");
    assert.equal(r.receipt.budgetLeft, "4.95");
    const d = await paywall.authorize("GET /x", "0.05", "x", r.proof);
    assert.equal(d.ok, true);
  });

  it("denies merchants outside the allow list and records it", async () => {
    await link();
    const r = await wallet.pay({ url: "http://evil.test/x", offer: await offer(), merchant: "Evil", resource: "GET /x" });
    assert.equal(r.status, "denied");
    assert.equal((wallet.status().ledger[0] as { status: string }).status, "denied");
  });

  it("holds large payments for owner approval, then charges on approve", async () => {
    await link();
    const r = await wallet.pay({ url: `${API}/x`, offer: await offer("bundle"), merchant: "Fee Oracle", resource: "GET /x" });
    assert.equal(r.status, "approval_required");
    if (r.status !== "approval_required") return;
    assert.equal(r.via, "owner");
    assert.equal(wallet.getApproval(r.approvalId)!.status, "pending");
    const approved = await wallet.approve(r.approvalId);
    assert.equal(approved.status, "paid");
    const a = wallet.getApproval(r.approvalId)!;
    assert.equal(a.status, "paid");
    assert.match(a.proof!, /^paypal-order /);
    assert.equal(wallet.status().spentToday, "1.00");
  });

  it("does not charge when the owner denies", async () => {
    await link();
    const r = await wallet.pay({ url: `${API}/x`, offer: await offer("bundle"), merchant: "Fee Oracle", resource: "GET /x" });
    assert.equal(r.status, "approval_required");
    if (r.status !== "approval_required") return;
    assert.equal(wallet.deny(r.approvalId), true);
    assert.equal((await wallet.approve(r.approvalId)).status, "failed");
    assert.equal(wallet.status().spentToday, "0.00");
  });

  it("falls back to a one-time PayPal approval when no account is linked", async () => {
    const r = await wallet.pay({ url: `${API}/x`, offer: await offer(), merchant: "Fee Oracle", resource: "GET /x" });
    assert.equal(r.status, "approval_required");
    if (r.status !== "approval_required") return;
    assert.equal(r.via, "paypal");
    assert.match(r.approveUrl!, /mock-paypal\/checkout\?token=/);
    const orderId = new URL(r.approveUrl!).searchParams.get("token")!;
    paypal.approveOrder(orderId);
    const done = await wallet.completeCheckout(orderId);
    assert.equal(done.status, "paid");
    assert.equal(done.status === "paid" && done.receipt.method, "checkout");
    const d = await paywall.authorize("GET /x", "0.05", "x", `paypal-order ${orderId}`);
    assert.equal(d.ok, true);
  });

  it("reports declined vault charges as failed", async () => {
    await link();
    paypal.declineNext = true;
    const r = await wallet.pay({ url: `${API}/x`, offer: await offer(), merchant: "Fee Oracle", resource: "GET /x" });
    assert.equal(r.status, "failed");
    assert.equal(wallet.status().spentToday, "0.00");
  });

  it("rejects tampered offers", async () => {
    await link();
    const o = { ...(await offer()), amount: "-1" };
    assert.equal((await wallet.pay({ url: `${API}/x`, offer: o, merchant: "Fee Oracle", resource: "GET /x" })).status, "denied");
  });
});
