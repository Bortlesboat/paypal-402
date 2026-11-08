// Subset of PayPal REST shapes that PayPal 402 relies on.
// Field names mirror the Orders v2 and Vault v3 APIs so the mock and the real
// adapter are interchangeable.

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface Capture {
  id: string;
  status: string; // COMPLETED | PENDING | DECLINED | ...
  amount: Money;
}

export interface PurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  description?: string;
  amount: Money;
  payee?: { merchant_id?: string; email_address?: string };
  payments?: { captures?: Capture[] };
}

export interface Order {
  id: string;
  status: string; // CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED
  intent?: string;
  purchase_units: PurchaseUnit[];
  payment_source?: {
    paypal?: {
      email_address?: string;
      attributes?: { vault?: { id?: string; status?: string; customer?: { id?: string } } };
    };
  };
  links?: Link[];
}

export interface CreateOrderInput {
  amount: string;
  currency: string;
  customId: string;
  description?: string;
  /** Vault v3 payment token. When set, the order is charged without a browser. */
  vaultId?: string;
  /** Required when vaultId is absent: where PayPal sends the buyer after approval. */
  returnUrl?: string;
  cancelUrl?: string;
  /** Idempotency key sent as PayPal-Request-Id. */
  requestId?: string;
  payeeMerchantId?: string;
}

export interface SetupToken {
  id: string;
  status: string;
  approveUrl?: string;
  customerId?: string;
}

export interface PaymentToken {
  id: string;
  customerId?: string;
  payerEmail?: string;
}

export interface PayPalAdapter {
  readonly mode: "mock" | "sandbox" | "live";
  readonly clientId?: string;
  createOrder(input: CreateOrderInput): Promise<Order>;
  getOrder(id: string): Promise<Order>;
  captureOrder(id: string, requestId?: string): Promise<Order>;
  createSetupToken(input: { returnUrl: string; cancelUrl: string; requestId?: string }): Promise<SetupToken>;
  createPaymentToken(setupTokenId: string, requestId?: string): Promise<PaymentToken>;
}

export class PayPalError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.details = details;
  }
}

export function approvalLink(links: Link[] | undefined): string | undefined {
  return links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
