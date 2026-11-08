import { PaidClient, WalletClient, type AgentEvent, type Emit } from "./client.ts";
import type { Provider, ToolSpec } from "./providers.ts";
import type { PaymentReceipt } from "../server/protocol.ts";

const SYSTEM = `You buy data from paid HTTP APIs on the user's behalf.

Paid endpoints answer HTTP 402 with offers: "per_call" (one request) or "bundle" (prepaid credits for many requests to the same merchant). Use pay_and_call to settle an offer; payment goes through the user's linked PayPal and their spending policy is enforced by the wallet, not by you. If a payment is denied, do not try to work around it; tell the user why. Prefer per_call unless you expect to make many requests to the same merchant in this task. Credits you already hold are used automatically by call_api.

Start with discover_apis to see prices. Do not call endpoints you do not need.

Final answer: plain text, short, specific numbers first. No headings.`;

const TOOLS: ToolSpec[] = [
  {
    name: "discover_apis",
    description: "List the priced endpoints a merchant exposes (route, price, description) and its bundle offer.",
    parameters: { type: "object", properties: { origin: { type: "string", description: "Merchant origin, e.g. http://localhost:4021" } }, required: ["origin"], additionalProperties: false },
  },
  {
    name: "call_api",
    description: "HTTP GET an API URL. Returns {status, data} or, for paid endpoints without payment, {status: 402, offers}.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "pay_and_call",
    description: "Pay for a 402 endpoint through the user's PayPal wallet (policy enforced), then retry the GET with proof of payment. May wait for the user's approval.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, option: { type: "string", enum: ["per_call", "bundle"] } },
      required: ["url", "option"],
      additionalProperties: false,
    },
  },
  {
    name: "wallet_status",
    description: "Spent today and budget left in the user's agent wallet.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

export interface AgentRun {
  answer: string;
  provider: string;
  receipts: PaymentReceipt[];
  spent: string;
  budgetLeft: string;
  events: AgentEvent[];
}

export async function runAgent(opts: { task: string; provider: Provider; walletUrl: string; agentKey: string; apiOrigin: string; emit?: Emit; approvalTimeoutMs?: number }): Promise<AgentRun> {
  const events: AgentEvent[] = [];
  const receipts: PaymentReceipt[] = [];
  const emit: Emit = (e) => {
    events.push(e);
    if (e.type === "receipt") receipts.push(e.receipt);
    opts.emit?.(e);
  };
  const wallet = new WalletClient(opts.walletUrl, opts.agentKey);
  const paid = new PaidClient(wallet, emit, opts.approvalTimeoutMs);
  const before = await wallet.status();

  // The agent may only reach merchants the owner allowed (plus the configured demo API).
  const allowed = new Set([...(before.policy.allowedOrigins as string[]), new URL(opts.apiOrigin).origin]);
  const checkUrl = (u: unknown): string => {
    const url = new URL(String(u));
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs");
    if (!allowed.has(url.origin) && !allowed.has("*")) throw new Error(`${url.origin} is not in the wallet's allowed merchants`);
    return url.toString();
  };

  const exec = async (name: string, input: Record<string, unknown>): Promise<string> => {
    emit({ type: "tool", name, input });
    switch (name) {
      case "discover_apis": {
        const origin = new URL(checkUrl(input.origin)).origin;
        const res = await fetch(`${origin}/.well-known/paypal402`);
        return JSON.stringify(await res.json());
      }
      case "call_api": {
        const r = await paid.call(checkUrl(input.url));
        if (r.paymentRequired) {
          return JSON.stringify({
            status: r.status,
            error: r.paymentRequired.error,
            merchant: r.paymentRequired.merchant.name,
            offers: r.paymentRequired.accepts.map((o) => ({ option: o.kind, amount: `$${o.amount}`, calls: o.calls, description: o.description })),
          });
        }
        return JSON.stringify({ status: r.status, data: r.data });
      }
      case "pay_and_call": {
        const option = input.option === "bundle" ? "bundle" : "per_call";
        const r = await paid.payAndCall(checkUrl(input.url), option);
        if (r.payment && r.payment.status !== "paid") return JSON.stringify({ status: 402, payment: r.payment });
        return JSON.stringify({ status: r.status, data: r.data, receipt: r.receipt });
      }
      case "wallet_status": {
        const s = await wallet.status();
        return JSON.stringify({ spentToday: s.spentToday, budgetLeft: s.budgetLeft });
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };

  let answer: string;
  try {
    answer = await opts.provider.run(SYSTEM, opts.task, TOOLS, exec, (text) => emit({ type: "step", text }));
  } catch (e) {
    emit({ type: "error", text: (e as Error).message });
    throw e;
  }
  emit({ type: "answer", text: answer });
  const after = await wallet.status();
  const spent = (Number(after.spentToday) - Number(before.spentToday)).toFixed(2);
  return { answer, provider: opts.provider.name, receipts, spent, budgetLeft: after.budgetLeft, events };
}
