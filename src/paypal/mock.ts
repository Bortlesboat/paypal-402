import { randomBytes } from "node:crypto";
import {
  PayPalError,
  type CreateOrderInput,
  type Order,
  type PayPalAdapter,
  type PaymentToken,
  type SetupToken,
} from "./types.ts";

const id = (prefix = "", n = 9) => prefix + randomBytes(n).toString("hex").toUpperCase().slice(0, 17);

interface MockOrderState {
  order: Order;
  returnUrl?: string;
  cancelUrl?: string;
}

/**
 * In-memory stand-in for PayPal sandbox. Same interface and response shapes as
 * RestPayPal; buyer approval happens on local pages served under /mock-paypal.
 */
export class MockPayPal implements PayPalAdapter {
  readonly mode = "mock" as const;
  readonly clientId = undefined;
  baseUrl: string;
  orders = new Map<string, MockOrderState>();
  setupTokens = new Map<string, { status: string; customerId: string; returnUrl: string; cancelUrl: string }>();
  paymentTokens = new Map<string, { customerId: string; email: string }>();
  #idempotency = new Map<string, unknown>();
  /** Test hook: make the next vault charge decline. */
  declineNext = false;

  constructor(baseUrl = "http://localhost:4020") {
    this.baseUrl = baseUrl;
  }

  #once<T>(key: string | undefined, fn: () => T): T {
    if (key && this.#idempotency.has(key)) return structuredClone(this.#idempotency.get(key)) as T;
    const out = fn();
    if (key) this.#idempotency.set(key, structuredClone(out));
    return out;
  }

  #capture(order: Order) {
    const pu = order.purchase_units[0];
    pu.payments = { captures: [{ id: id("CAP-"), status: "COMPLETED", amount: { ...pu.amount } }] };
    order.status = "COMPLETED";
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    if (!/^\d+(\.\d{1,2})?$/.test(input.amount)) throw new PayPalError("INVALID_PARAMETER_VALUE", 422);
    if (input.customId.length > 127) throw new PayPalError("custom_id too long", 422);
    return this.#once(input.requestId, () => {
      const order: Order = {
        id: id("", 9),
        status: "CREATED",
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: input.customId,
            description: input.description,
            amount: { currency_code: input.currency, value: input.amount },
            ...(input.payeeMerchantId ? { payee: { merchant_id: input.payeeMerchantId } } : {}),
          },
        ],
      };
      if (input.vaultId) {
        const tok = this.paymentTokens.get(input.vaultId);
        if (!tok) throw new PayPalError("INVALID_RESOURCE_ID: vault_id", 422);
        if (this.declineNext) {
          this.declineNext = false;
          throw new PayPalError("INSTRUMENT_DECLINED", 422);
        }
        order.payment_source = { paypal: { email_address: tok.email } };
        this.#capture(order); // vaulted PayPal + intent CAPTURE completes in one call
      } else {
        order.status = "PAYER_ACTION_REQUIRED";
        order.links = [
          { href: `${this.baseUrl}/mock-paypal/checkout?token=${order.id}`, rel: "payer-action", method: "GET" },
        ];
      }
      this.orders.set(order.id, { order, returnUrl: input.returnUrl, cancelUrl: input.cancelUrl });
      return structuredClone(order);
    });
  }

  async getOrder(orderId: string): Promise<Order> {
    const s = this.orders.get(orderId);
    if (!s) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
    return structuredClone(s.order);
  }

  async captureOrder(orderId: string, requestId?: string): Promise<Order> {
    return this.#once(requestId, () => {
      const s = this.orders.get(orderId);
      if (!s) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
      if (s.order.status === "COMPLETED") throw new PayPalError("ORDER_ALREADY_CAPTURED", 422);
      if (s.order.status !== "APPROVED") throw new PayPalError("ORDER_NOT_APPROVED", 422);
      this.#capture(s.order);
      return structuredClone(s.order);
    });
  }

  async createSetupToken(input: { returnUrl: string; cancelUrl: string; requestId?: string }): Promise<SetupToken> {
    return this.#once(input.requestId, () => {
      const tokenId = id("", 9);
      const customerId = id("CUST-", 6);
      this.setupTokens.set(tokenId, { status: "PAYER_ACTION_REQUIRED", customerId, ...input });
      return {
        id: tokenId,
        status: "PAYER_ACTION_REQUIRED",
        customerId,
        approveUrl: `${this.baseUrl}/mock-paypal/vault?approval_token_id=${tokenId}`,
      };
    });
  }

  async createPaymentToken(setupTokenId: string): Promise<PaymentToken> {
    const st = this.setupTokens.get(setupTokenId);
    if (!st) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
    if (st.status !== "APPROVED") throw new PayPalError("SETUP_TOKEN_NOT_APPROVED", 422);
    const tokenId = id("", 4).toLowerCase();
    const email = "sb-buyer@personal.example.com";
    this.paymentTokens.set(tokenId, { customerId: st.customerId, email });
    st.status = "VAULTED";
    return { id: tokenId, customerId: st.customerId, payerEmail: email };
  }

  // --- buyer-side simulation (what the PayPal approval page does) ---

  approveOrder(orderId: string): string | undefined {
    const s = this.orders.get(orderId);
    if (!s || s.order.status !== "PAYER_ACTION_REQUIRED") return undefined;
    s.order.status = "APPROVED";
    return s.returnUrl;
  }

  approveSetupToken(tokenId: string): string | undefined {
    const st = this.setupTokens.get(tokenId);
    if (!st || st.status !== "PAYER_ACTION_REQUIRED") return undefined;
    st.status = "APPROVED";
    return st.returnUrl;
  }
}
