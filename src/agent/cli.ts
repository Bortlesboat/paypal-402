import { existsSync } from "node:fs";
import { runAgent } from "./agent.ts";
import { providerFromEnv } from "./providers.ts";
import type { AgentEvent } from "./client.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const task =
  process.argv.slice(2).join(" ").trim() ||
  "What fee should I pay to get my Bitcoin tx confirmed within an hour? Also summarize the mempool.";
const walletUrl = process.env.WALLET_URL || `http://localhost:${process.env.PORT || 4020}`;
const apiOrigin = process.env.API_ORIGIN || `http://localhost:${process.env.MERCHANT_PORT || 4021}`;
const agentKey = process.env.AGENT_KEY || "local-agent-key";
const provider = providerFromEnv(process.env, apiOrigin);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function show(e: AgentEvent) {
  switch (e.type) {
    case "step":
      return console.log(dim(`  ${e.text}`));
    case "tool":
      return console.log(`> ${e.name} ${dim(JSON.stringify(e.input))}`);
    case "http":
      return console.log(dim(`  GET ${e.url} -> ${e.status}${e.paidWith ? ` (${e.paidWith})` : ""}`));
    case "payment_required":
      return console.log(`  402 Payment Required: ${e.offers.map((o) => `${o.kind} $${o.amount}${o.calls > 1 ? `/${o.calls} calls` : ""}`).join(", ")}`);
    case "policy":
      return console.log(`  policy: ${e.decision}${e.reason ? ` (${e.reason})` : ""}`);
    case "approval":
      if (e.status === "pending") {
        console.log(bold(`  Approval needed: ${e.reason}`));
        console.log(`  ${e.approveUrl ? `Approve on PayPal: ${e.approveUrl}` : `Approve in the dashboard: ${walletUrl}`}`);
      } else console.log(`  approval ${e.status}`);
      return;
    case "paid":
      return console.log(`  paid $${e.amount} via PayPal ${e.method} · order ${e.orderId}${e.captureId ? ` · capture ${e.captureId}` : ""} · $${e.budgetLeft} left today`);
    case "receipt":
      if (e.receipt.creditToken) console.log(dim(`  credits left with this merchant: ${e.receipt.creditsRemaining}`));
      return;
    case "error":
      return console.log(`  error: ${e.text}`);
  }
}

console.log(dim(`${provider.name} · wallet ${walletUrl} · api ${apiOrigin}\n`));
console.log(bold(task) + "\n");
try {
  const run = await runAgent({ task, provider, walletUrl, agentKey, apiOrigin, emit: show });
  console.log("\n" + run.answer + "\n");
  const orders = run.receipts.filter((r) => r.orderId);
  console.log(dim(`spent $${run.spent} · ${orders.length} PayPal capture(s) · $${run.budgetLeft} left today`));
  for (const r of orders) console.log(dim(`  order ${r.orderId}  capture ${r.captureId}  $${r.amount}`));
} catch (e) {
  console.error(`\nfailed: ${(e as Error).message}`);
  if (/ECONNREFUSED|fetch failed/.test(String((e as Error).message))) console.error("Is the demo running? Start it with: npm run demo");
  process.exit(1);
}
