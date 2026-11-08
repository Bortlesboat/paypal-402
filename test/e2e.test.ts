import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runAgent } from "../src/agent/agent.ts";
import { PaidClient, WalletClient } from "../src/agent/client.ts";
import { ScriptedProvider } from "../src/agent/providers.ts";
import { startDemo } from "../src/demo/app.ts";

process.env.MEMPOOL_OFFLINE = "1";

describe("end to end with mock PayPal", () => {
  let demo: Awaited<ReturnType<typeof startDemo>>;
  let cookie = "";
  const owner = (path: string, init: RequestInit = {}) =>
    fetch(demo.walletUrl + path, { ...init, redirect: "manual", headers: { cookie, "Content-Type": "application/json", ...(init.headers ?? {}) } });

  before(async () => {
    demo = await startDemo({ walletPort: 0, merchantPort: 0, env: { AGENT_KEY: "test-agent-key" } });
    demo.provider; // scripted unless keys are set; tests pass their own provider below
    const home = await fetch(demo.walletUrl + "/");
    cookie = (home.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^p402_owner=/);
  });
  after(() => demo.close());

  it("serves 402 to unpaid requests", async () => {
    const res = await fetch(`${demo.apiOrigin}/api/fees/recommend?target=60`);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.protocol, "paypal-402/1");
    assert.equal(body.accepts.length, 2);
  });

  it("links PayPal through the hosted approval redirect", async () => {
    const { approveUrl, setupTokenId } = await (await owner("/wallet/link", { method: "POST" })).json();
    assert.ok(approveUrl);
    const approve = await fetch(new URL("/mock-paypal/vault/approve", demo.walletUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `id=${setupTokenId}`,
    });
    const back = approve.headers.get("location")!;
    assert.match(back, /\/wallet\/link\/return\?approval_token_id=/);
    const ret = await owner(new URL(back).pathname + new URL(back).search);
    assert.equal(ret.status, 302);
    const st = await (await owner("/wallet/status")).json();
    assert.equal(st.linked, true);
  });

  it("agent hits 402, pays through PayPal within policy, and gets data", async () => {
    const run = await runAgent({
      task: "What fee should I pay to get my Bitcoin tx confirmed within an hour? Summarize the mempool.",
      provider: new ScriptedProvider(demo.apiOrigin),
      walletUrl: demo.walletUrl,
      agentKey: "test-agent-key",
      apiOrigin: demo.apiOrigin,
    });
    assert.match(run.answer, /sat\/vB/);
    assert.match(run.answer, /Mempool:/);
    assert.equal(run.spent, "0.08");
    assert.equal(run.receipts.filter((r) => r.orderId).length, 2);
    assert.ok(run.events.some((e) => e.type === "payment_required"));
    assert.ok(run.events.some((e) => e.type === "paid"));

    const stats = demo.paywall.stats();
    assert.equal(stats.revenue, "0.08");
    assert.equal(stats.captures, 2);

    // Replaying a used order id is rejected by the merchant.
    const res = await fetch(`${demo.apiOrigin}/api/fees/recommend?target=60`, { headers: { "X-PAYMENT": `paypal-order ${run.receipts[0].orderId}` } });
    assert.equal(res.status, 409);
  });

  it("agent key cannot approve or change policy", async () => {
    const headers = { Authorization: "Bearer test-agent-key", "Content-Type": "application/json" };
    const pol = await fetch(demo.walletUrl + "/wallet/policy", { method: "PUT", headers, body: JSON.stringify({ dailyBudget: "999" }) });
    assert.equal(pol.status, 403);
    const ap = await fetch(demo.walletUrl + "/wallet/approvals/x/approve", { method: "POST", headers });
    assert.equal(ap.status, 403);
    const anon = await fetch(demo.walletUrl + "/wallet/pay", { method: "POST" });
    assert.equal(anon.status, 401);
  });

  it("bundle above the approval threshold waits for the owner, then credits cover later calls", async () => {
    const events: string[] = [];
    const paid = new PaidClient(new WalletClient(demo.walletUrl, "test-agent-key"), async (e) => {
      events.push(e.type);
      if (e.type === "approval" && e.status === "pending") {
        const r = await owner(`/wallet/approvals/${e.approvalId}/approve`, { method: "POST" });
        assert.equal((await r.json()).status, "paid");
      }
    }, 10_000);
    const url = `${demo.apiOrigin}/api/mempool/summary`;
    const first = await paid.call(url);
    assert.equal(first.status, 402);
    const r = await paid.payAndCall(url, "bundle");
    assert.equal(r.status, 200);
    assert.equal(r.receipt?.creditsRemaining, 49);
    assert.ok(events.includes("approval"));

    const next = await paid.call(`${demo.apiOrigin}/api/fees/recommend?target=30`);
    assert.equal(next.status, 200);
    assert.equal(next.receipt?.scheme, "paypal-credit");
    assert.equal(next.receipt?.creditsRemaining, 48);
  });

  it("denies payments once the daily budget is used up", async () => {
    await owner("/wallet/policy", { method: "PUT", body: JSON.stringify({ dailyBudget: "1.10" }) });
    const paid = new PaidClient(new WalletClient(demo.walletUrl, "test-agent-key"));
    // credits for this origin would bypass payment; clear them to force a new purchase
    await new WalletClient(demo.walletUrl, "test-agent-key").setCredit(demo.apiOrigin, "x", 0);
    const r = await paid.payAndCall(`${demo.apiOrigin}/api/fees/recommend?target=60`, "per_call");
    assert.equal(r.status, 402);
    assert.equal(r.payment?.status, "denied");
  });
});
