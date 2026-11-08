// Wire format shared by the server middleware and the agent-side client.

export const PROTOCOL = "paypal-402/1";
export const PAYMENT_HEADER = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "x-payment-response";

export type OfferKind = "per_call" | "bundle";

export interface PaymentOffer {
  /** Binds a PayPal order to this offer. The payer puts it in purchase_units[0].custom_id. */
  id: string;
  scheme: "paypal-order";
  kind: OfferKind;
  amount: string;
  currency: string;
  calls: number;
  /** Unix seconds. Orders must be created against an unexpired offer. */
  expiresAt: number;
  description: string;
}

export interface PaymentRequired {
  protocol: typeof PROTOCOL;
  error: "payment_required" | string;
  message?: string;
  resource: string;
  merchant: { name: string; payee?: string };
  accepts: PaymentOffer[];
  /** How to present proof on the retry. */
  header: string;
  formats: { order: string; credit: string };
}

export interface PaymentReceipt {
  scheme: "paypal-order" | "paypal-credit";
  orderId?: string;
  captureId?: string;
  amount?: string;
  currency?: string;
  creditToken?: string;
  creditsRemaining?: number;
}

export type PaymentProof = { scheme: "paypal-order"; orderId: string } | { scheme: "paypal-credit"; token: string };

export function formatProof(p: PaymentProof): string {
  return p.scheme === "paypal-order" ? `paypal-order ${p.orderId}` : `paypal-credit ${p.token}`;
}

export function parseProof(header: string | undefined): PaymentProof | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.trim().split(/\s+/, 2);
  if (!value || !/^[A-Za-z0-9_-]{6,128}$/.test(value)) return undefined;
  if (scheme === "paypal-order") return { scheme, orderId: value };
  if (scheme === "paypal-credit") return { scheme, token: value };
  return undefined;
}

export function encodeReceipt(r: PaymentReceipt): string {
  return Buffer.from(JSON.stringify(r)).toString("base64url");
}

export function decodeReceipt(h: string | null | undefined): PaymentReceipt | undefined {
  if (!h) return undefined;
  try {
    return JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as PaymentReceipt;
  } catch {
    return undefined;
  }
}

/** Money as integer cents to avoid float drift. */
export function toCents(v: string | number): number {
  return Math.round(Number(v) * 100);
}

export function fromCents(c: number): string {
  return (c / 100).toFixed(2);
}
