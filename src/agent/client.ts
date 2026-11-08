import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  decodeReceipt,
  formatProof,
  type OfferKind,
  type PaymentReceipt,
  type PaymentRequired,
} from "../server/protocol.ts";
import type { PayResult } from "../wallet/wallet.ts";

export type AgentEvent =
  | { type: "step"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "http"; method: string; url: string; status: number; paidWith?: string }
  | { type: "payment_required"; url: string; offers: { kind: OfferKind; amount: string; calls: number }[] }
  | { type: "policy"; decision: string; reason?: string }
  | { type: "approval"; approvalId: string; via: string; reason: string; approveUrl?: string; status: string }
  | { type: "paid"; amount: string; calls: number; orderId: string; captureId?: string; method: string; budgetLeft: string }
  | { type: "receipt"; receipt: PaymentReceipt }
  | { type: "answer"; text: string }
  | { type: "error"; text: string };

export type Emit = (e: AgentEvent) => void;

/** HTTP client for the wallet service, authenticated with the agent key. */
export class WalletClient {
  readonly baseUrl: string;
  readonly agentKey: string;
  constructor(baseUrl: string, agentKey: string) {
    this.baseUrl = baseUrl;
    this.agentKey = agentKey;
  }

  async #req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${this.agentKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`wallet ${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  status() {
    return this.#req<{ budgetLeft: string; spentToday: string; linked: boolean; policy: Record<string, unknown> }>("GET", "/wallet/status");
  }
  pay(body: unknown) {
    return this.#req<PayResult>("POST", "/wallet/pay", body);
  }
  approval(id: string) {
    return this.#req<{ status: string; proof?: string; reason: string; ledgerId?: string; captureId?: string; amount: string; calls: number; via: string }>("GET", `/wallet/approvals/${id}`);
  }
  getCredit(origin: string) {
    return this.#req<{ token: string; remaining: number } | null>("GET", `/wallet/credits?origin=${encodeURIComponent(origin)}`);
  }
  setCredit(origin: string, token: string, remaining: number) {
    return this.#req("PUT", "/wallet/credits", { origin, token, remaining });
  }
}

export interface CallResult {
  status: number;
  data?: unknown;
  paymentRequired?: PaymentRequired;
  receipt?: PaymentReceipt;
}

/** Fetch wrapper that understands 402 and settles through the wallet. */
export class PaidClient {
  #last = new Map<string, PaymentRequired>();
  readonly wallet: WalletClient;
  readonly emit: Emit;
  readonly approvalTimeoutMs: number;
  constructor(wallet: WalletClient, emit: Emit = () => {}, approvalTimeoutMs = 180_000) {
    this.wallet = wallet;
    this.emit = emit;
    this.approvalTimeoutMs = approvalTimeoutMs;
  }

  async #get(url: string, proof?: string): Promise<CallResult> {
    const res = await fetch(url, { headers: proof ? { [PAYMENT_HEADER]: proof } : {} });
    const body = await res.json().catch(() => undefined);
    const receipt = decodeReceipt(res.headers.get(PAYMENT_RESPONSE_HEADER));
    this.emit({ type: "http", method: "GET", url, status: res.status, paidWith: proof?.split(" ")[0] });
    if (receipt) {
      this.emit({ type: "receipt", receipt });
      if (receipt.creditToken !== undefined && receipt.creditsRemaining !== undefined) {
        await this.wallet.setCredit(new URL(url).origin, receipt.creditToken, receipt.creditsRemaining);
      }
    }
    if (res.status === 402 || res.status === 409) {
      const pr = body as PaymentRequired;
      this.#last.set(url, pr);
      return { status: res.status, paymentRequired: pr };
    }
    return { status: res.status, data: body, receipt };
  }

  /** GET a URL, spending prepaid credits automatically if the wallet holds some for that origin. */
  async call(url: string): Promise<CallResult> {
    const origin = new URL(url).origin;
    const credit = await this.wallet.getCredit(origin);
    if (credit) {
      const r = await this.#get(url, formatProof({ scheme: "paypal-credit", token: credit.token }));
      if (r.status !== 402) return r;
      await this.wallet.setCredit(origin, credit.token, 0); // exhausted or revoked
    }
    const r = await this.#get(url);
    if (r.paymentRequired) {
      this.emit({
        type: "payment_required",
        url,
        offers: r.paymentRequired.accepts.map((o) => ({ kind: o.kind, amount: o.amount, calls: o.calls })),
      });
    }
    return r;
  }

  /** Pay one of the offers from the last 402 for this URL, then retry the request with proof. */
  async payAndCall(url: string, kind: OfferKind): Promise<CallResult & { payment?: PayResult }> {
    let pr = this.#last.get(url);
    if (!pr) {
      const first = await this.call(url);
      if (!first.paymentRequired) return first;
      pr = first.paymentRequired;
    }
    const offer = pr.accepts.find((o) => o.kind === kind) ?? pr.accepts[0];
    let result = await this.wallet.pay({ url, offer, merchant: pr.merchant.name, resource: pr.resource });

    if (result.status === "approval_required") {
      this.emit({ type: "policy", decision: "approval_required", reason: result.reason });
      this.emit({ type: "approval", approvalId: result.approvalId, via: result.via, reason: result.reason, approveUrl: result.approveUrl, status: "pending" });
      result = await this.#waitForApproval(result.approvalId);
    } else {
      this.emit({ type: "policy", decision: result.status === "paid" ? "allowed" : result.status, reason: "reason" in result ? result.reason : undefined });
    }
    if (result.status !== "paid") return { status: 402, paymentRequired: pr, payment: result };

    this.emit({
      type: "paid",
      amount: result.receipt.amount,
      calls: result.receipt.calls,
      orderId: result.receipt.orderId,
      captureId: result.receipt.captureId,
      method: result.receipt.method,
      budgetLeft: result.receipt.budgetLeft,
    });
    this.#last.delete(url);
    const r = await this.#get(url, result.proof);
    return { ...r, payment: result };
  }

  async #waitForApproval(id: string): Promise<PayResult> {
    const deadline = Date.now() + this.approvalTimeoutMs;
    while (Date.now() < deadline) {
      const a = await this.wallet.approval(id);
      if (a.status !== "pending") {
        this.emit({ type: "approval", approvalId: id, via: a.via, reason: a.reason, status: a.status });
        if (a.status === "paid" && a.proof) {
          const st = await this.wallet.status();
          const orderId = a.proof.split(" ")[1];
          return {
            status: "paid",
            proof: a.proof,
            receipt: { ledgerId: a.ledgerId ?? "", orderId, captureId: a.captureId, amount: a.amount, currency: "USD", calls: a.calls, method: a.via === "paypal" ? "checkout" : "vault", budgetLeft: st.budgetLeft },
          };
        }
        return { status: "denied", reason: a.reason };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status: "failed", reason: "Timed out waiting for approval" };
  }
}
