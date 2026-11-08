# PayPal 402: let any API charge AI agents per call through PayPal

## Inspiration

I run a paid Bitcoin data API (bitcoinsapi.com) and contribute to x402, the open protocol that brings back HTTP's long-unused `402 Payment Required` status so software can pay for software. x402 works well for agents that hold stablecoins. Most people don't, but hundreds of millions of them already have PayPal.

Today, if an AI agent needs a paid API, a human has to sign up, enter a card, buy credits, paste an API key, and hope the agent doesn't burn through it. That breaks the moment an agent finds a useful API the human has never heard of. I wanted the x402 experience on a rail people already trust: link PayPal once, set a budget, and let the agent pay per call.

## What it does

PayPal 402 has three parts that work together:

- **Merchant middleware.** One line puts a price on an Express route. An unpaid request gets `402` with machine-readable PayPal terms: $0.05 for one call, or $1.00 for 50 prepaid calls. A paid request carries a PayPal order id. The middleware verifies it with the PayPal Orders API, checks that it was paid for this route at this price, blocks replays, and serves the response with a receipt.
- **Agent wallet.** The human links PayPal once through the Vault v3 "save PayPal" flow and sets a policy: a daily budget, a max per call, an approval threshold, and the merchants the agent may pay. From then on the wallet charges the saved PayPal account without a browser. Payments above the threshold wait for a one-click approval in the dashboard. If no account is linked, the agent still works: each payment becomes a PayPal approval link.
- **AI agent.** Claude, via tool use, gets a task like "what fee gets my Bitcoin transaction confirmed within an hour, and how busy is the mempool?" It discovers the merchant's prices, calls the endpoint, hits 402, decides between per-call and bundle, pays through the wallet, retries, and answers with the numbers and a receipt: PayPal order and capture ids, the amount spent, and the budget left.

The demo merchant is a Bitcoin fee oracle that serves live mempool.space data. The dashboard shows both sides at once: the agent's run as a live timeline (402, policy check, approval, PayPal capture, answer) next to the wallet's budget and receipts, and a merchant view with revenue, captures and calls per endpoint.

## How we built it

- **TypeScript on Node 24**, using native type stripping, so there is no build step. There are two runtime dependencies (`express`, `@anthropic-ai/sdk`). Storage is the built-in `node:sqlite`.
- **PayPal REST APIs**:
  - OAuth2 client credentials
  - `POST /v2/checkout/orders` with `payment_source.paypal.vault_id`, for merchant-initiated charges
  - `GET /v2/checkout/orders/{id}`, for server-side verification
  - `POST /v2/checkout/orders/{id}/capture`
  - `POST /v3/vault/setup-tokens` and `POST /v3/vault/payment-tokens`, to save PayPal without a purchase
  - the JS SDK `createVaultSetupToken` button on the dashboard

  Every POST carries a `PayPal-Request-Id` derived from the offer, so retries never double-charge.
- **Offer binding without state.** Each 402 offer id is an HMAC over route, amount, currency, expiry and nonce. It travels inside the PayPal order's `custom_id`, so the merchant can prove an order was paid for exactly this resource without storing anything until money arrives.
- **Replay protection.** Redeemed order ids are a SQLite primary key, so redemption is atomic even under concurrent retries. Prepaid credits decrement with a guarded `UPDATE`.
- **Pluggable AI.** Claude is the default (tool use, model from env). An OpenAI-compatible adapter covers OpenAI and local Ollama. With no key at all, a labeled scripted planner drives the same tools, so judges can see the payment flow without any account.
- **A mock PayPal** with the same interface and response shapes as the REST adapter, including local approval pages. It lets the full flow run, and be tested, before sandbox credentials exist.
- **Tests.** 38 unit and end-to-end tests cover the 402 shape, verification, replay rejection (including concurrent replays), wrong-route and underpayment attacks, expired offers, credit exhaustion, policy enforcement, owner-only approvals, and a full agent run.

## Challenges we ran into

- **Who can create an order.** In PayPal, only the payee's app can create an order, so a buyer-side wallet can't simply "send" money to an arbitrary API. The working design is a facilitator, like x402's. The wallet service owns the PayPal app and vaulted payment token, and charges with the merchant as payee. In this demo the merchant and the facilitator share one sandbox app. Paying third-party merchants in production needs PayPal's multiparty (partner) onboarding, so the middleware already checks `payee.merchant_id` when one is configured.
- **Keeping the LLM away from money.** The model only gets a `pay_and_call` tool. Policy lives in the wallet service, the agent key can't approve or change limits, and the agent's HTTP tools can only reach allowed merchants. A prompt injection can make the agent want to pay. It can't make the wallet pay outside the policy.
- **Micropayment economics.** Card-style fees make $0.05 captures expensive. Bundles ($1.00 for 50 calls, judged by unit price against the per-call cap) keep the per-call experience while settling a larger amount.
- **Honest limits.**
  - Vault v3 linking and vaulted charges are implemented against PayPal's documented endpoints and pass against the mock. Sandbox behavior still has to be confirmed with real credentials.
  - The demo owner session is a local cookie, not real authentication.
  - A paid call is consumed even if the upstream data source then fails.

## Accomplishments that we're proud of

- An agent pays a real API per call, with PayPal, with no browser in the loop after a one-time link, and every payment is verified server-side.
- The merchant integration really is one line, and the wallet's guardrails are enforced in code, not in the prompt.
- The whole thing runs with `npm install && npm run demo` and no accounts.

## What we learned

- Agents need spending policy more than they need payment methods. Budgets, allow lists and approval thresholds are what make delegating money acceptable.
- PayPal's Vault v3 plus `vault_id` orders is a good fit for merchant-initiated agent payments. `custom_id` is a natural place to bind a payment to a protocol-level offer.

## What's next

- PayPal multiparty / partner onboarding so any API owner can accept agent payments to their own PayPal account through one facilitator.
- A Hono and Cloudflare Workers build of the middleware, plus Python (FastAPI) middleware.
- Publish `paypal-402/1` alongside x402 so one 402 response can advertise both stablecoin and PayPal payment options, and agents pay with whichever their human set up.
- An MCP server that exposes the wallet, so any MCP-capable agent can pay 402 APIs within the user's policy.
- Webhooks (`PAYMENT.CAPTURE.REFUNDED`) to revoke credits on refunds, plus automatic credit refunds when an upstream call fails.
