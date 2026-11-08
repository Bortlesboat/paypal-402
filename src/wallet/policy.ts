import { toCents } from "../server/protocol.ts";

export interface SpendingPolicy {
  /** Max total spend per UTC day, in USD. */
  dailyBudget: string;
  /** Max unit price per API call (bundle price / calls), in USD. */
  perCallCap: string;
  /** Any single payment above this needs a human approval. */
  approvalAbove: string;
  /** Origins the agent may pay. Empty list = none. "*" = any. */
  allowedOrigins: string[];
  paused: boolean;
}

export const DEFAULT_POLICY: SpendingPolicy = {
  dailyBudget: "5.00",
  perCallCap: "0.10",
  approvalAbove: "0.50",
  allowedOrigins: [],
  paused: false,
};

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "approve"; reason: string }
  | { decision: "deny"; reason: string };

export interface PaymentAsk {
  origin: string;
  amount: string;
  calls: number;
  spentTodayCents: number;
}

export function evaluatePolicy(p: SpendingPolicy, ask: PaymentAsk): PolicyDecision {
  const amount = toCents(ask.amount);
  if (p.paused) return { decision: "deny", reason: "Wallet is paused" };
  if (!p.allowedOrigins.includes("*") && !p.allowedOrigins.includes(ask.origin)) {
    return { decision: "deny", reason: `${ask.origin} is not an allowed merchant` };
  }
  if (!Number.isInteger(ask.calls) || ask.calls < 1) return { decision: "deny", reason: "Invalid call count" };
  const unit = amount / ask.calls;
  if (unit > toCents(p.perCallCap)) {
    return { decision: "deny", reason: `Unit price $${(unit / 100).toFixed(3)} exceeds per-call cap $${p.perCallCap}` };
  }
  const budget = toCents(p.dailyBudget);
  if (ask.spentTodayCents + amount > budget) {
    return { decision: "deny", reason: `Would exceed daily budget ($${((budget - ask.spentTodayCents) / 100).toFixed(2)} left)` };
  }
  if (amount > toCents(p.approvalAbove)) {
    return { decision: "approve", reason: `$${ask.amount} is above the $${p.approvalAbove} approval threshold` };
  }
  return { decision: "allow" };
}

export function validatePolicy(input: unknown): SpendingPolicy {
  const p = { ...DEFAULT_POLICY, ...(input as Partial<SpendingPolicy>) };
  const money = /^\d{1,6}(\.\d{1,2})?$/;
  for (const k of ["dailyBudget", "perCallCap", "approvalAbove"] as const) {
    p[k] = String(p[k]);
    if (!money.test(p[k])) throw new Error(`${k} must be a USD amount`);
    p[k] = Number(p[k]).toFixed(2);
  }
  if (!Array.isArray(p.allowedOrigins)) throw new Error("allowedOrigins must be an array");
  p.allowedOrigins = p.allowedOrigins.map((o) => (o === "*" ? o : new URL(String(o)).origin));
  p.paused = Boolean(p.paused);
  return p;
}
