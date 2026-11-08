import { randomUUID } from "node:crypto";
import {
  PayPalError,
  approvalLink,
  type CreateOrderInput,
  type Order,
  type PayPalAdapter,
  type PaymentToken,
  type SetupToken,
} from "./types.ts";

const BASE = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

/**
 * Real PayPal adapter. Talks to the documented REST endpoints:
 *   POST /v1/oauth2/token                      client-credentials token
 *   POST /v2/checkout/orders                   create (and, with vault_id, charge) an order
 *   GET  /v2/checkout/orders/{id}              verify an order server-side
 *   POST /v2/checkout/orders/{id}/capture      capture an approved order
 *   POST /v3/vault/setup-tokens                start "save PayPal for later"
 *   POST /v3/vault/payment-tokens              exchange an approved setup token for a payment token
 */
export class RestPayPal implements PayPalAdapter {
  readonly mode: "sandbox" | "live";
  readonly clientId: string;
  #secret: string;
  #base: string;
  #token?: { value: string; expiresAt: number };

  constructor(opts: { clientId: string; clientSecret: string; env?: "sandbox" | "live" }) {
    this.mode = opts.env ?? "sandbox";
    this.clientId = opts.clientId;
    this.#secret = opts.clientSecret;
    this.#base = BASE[this.mode];
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const res = await fetch(`${this.#base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.#secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new PayPalError("PayPal OAuth failed", res.status, body);
    this.#token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  async #call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.#accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (method === "POST") headers["PayPal-Request-Id"] = requestId ?? randomUUID();
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; name?: string };
    if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} failed: ${json.name ?? res.status}`, res.status, json);
    return json;
  }

  createOrder(input: CreateOrderInput): Promise<Order> {
    const paypal: Record<string, unknown> = input.vaultId
      ? { vault_id: input.vaultId }
      : {
          experience_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            brand_name: "PayPal 402",
          },
        };
    return this.#call<Order>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: input.customId,
            description: input.description?.slice(0, 127),
            amount: { currency_code: input.currency, value: input.amount },
            ...(input.payeeMerchantId ? { payee: { merchant_id: input.payeeMerchantId } } : {}),
          },
        ],
        payment_source: { paypal },
      },
      input.requestId,
    );
  }

  getOrder(id: string): Promise<Order> {
    return this.#call<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }

  captureOrder(id: string, requestId?: string): Promise<Order> {
    return this.#call<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, requestId);
  }

  async createSetupToken(input: { returnUrl: string; cancelUrl: string; requestId?: string }): Promise<SetupToken> {
    const res = await this.#call<{ id: string; status: string; customer?: { id?: string }; links?: { href: string; rel: string }[] }>(
      "POST",
      "/v3/vault/setup-tokens",
      {
        payment_source: {
          paypal: {
            description: "PayPal 402 agent wallet",
            usage_pattern: "IMMEDIATE",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: false,
            experience_context: {
              shipping_preference: "NO_SHIPPING",
              brand_name: "PayPal 402",
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      },
      input.requestId,
    );
    return { id: res.id, status: res.status, customerId: res.customer?.id, approveUrl: approvalLink(res.links) };
  }

  async createPaymentToken(setupTokenId: string, requestId?: string): Promise<PaymentToken> {
    const res = await this.#call<{ id: string; customer?: { id?: string }; payment_source?: { paypal?: { email_address?: string } } }>(
      "POST",
      "/v3/vault/payment-tokens",
      { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
      requestId,
    );
    return { id: res.id, customerId: res.customer?.id, payerEmail: res.payment_source?.paypal?.email_address };
  }
}
