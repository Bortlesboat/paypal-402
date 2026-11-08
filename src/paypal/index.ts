import { MockPayPal } from "./mock.ts";
import { RestPayPal } from "./rest.ts";
import type { PayPalAdapter } from "./types.ts";

export * from "./types.ts";
export { MockPayPal } from "./mock.ts";
export { RestPayPal } from "./rest.ts";

/** Real sandbox adapter when credentials are present, otherwise the mock. */
export function paypalFromEnv(env = process.env, baseUrl?: string): PayPalAdapter {
  const forceMock = env.PAYPAL_MODE === "mock";
  if (!forceMock && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return new RestPayPal({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      env: env.PAYPAL_MODE === "live" ? "live" : "sandbox",
    });
  }
  return new MockPayPal(baseUrl);
}
