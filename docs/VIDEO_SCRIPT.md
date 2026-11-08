# Demo video script (target 2:30, hard limit 3:00)

Screen: browser at http://localhost:4020 next to a terminal. Real PayPal sandbox if creds are in, otherwise mock (the pill in the top right says which). Reset first: restart `npm run demo` (mock mode starts clean).

| Time | Screen | Voiceover |
| --- | --- | --- |
| 0:00-0:15 | README title, then the dashboard | "AI agents call paid APIs all day, but API billing still assumes a human with a card. Crypto has x402 for this. PayPal 402 does the same thing for the 400 million people who already have PayPal." |
| 0:15-0:35 | Editor: `src/demo/merchant.ts`, highlight `paywall.charge({ price: "0.05" })`. Terminal: `curl -i localhost:4021/api/fees/recommend` showing `402` and the JSON offers | "For an API owner it's one line: put a price on a route. An unpaid call gets HTTP 402 with PayPal terms: five cents a call, or a dollar for fifty." |
| 0:35-0:55 | Dashboard, Wallet card: click **Link PayPal**, approve on the PayPal page, land back showing the linked account | "The human links PayPal once. It's PayPal's Vault: we save a payment token, never a card number." |
| 0:55-1:10 | Policy card: daily budget $5, max per call $0.10, ask me above $0.50, allowed merchant | "Then they set the rules: a daily budget, a max per call, when to ask, and which merchants are allowed. The agent can't change any of this." |
| 1:10-1:45 | Pick the **Batch payouts** preset, click **Run agent**. Timeline: discover, 402, Claude chooses the $1 bundle, "Needs your approval" card. Click **Approve** | "Now the agent, Claude with tool use, gets a real task: what fee gets a Bitcoin transaction confirmed within 30 minutes. It finds the prices, hits a 402, and decides the bundle is cheaper for this job. A dollar is over my approval threshold, so it asks me. One click." |
| 1:45-2:05 | Timeline: "Paid $1.00 with PayPal", order and capture ids, `200`, then "Used prepaid credit, 48 left" on the second endpoint, then the answer card | "The wallet charges PayPal with no browser. The merchant verifies the order with PayPal's API on its own server, then serves the data. The next call spends a prepaid credit, so there's no second charge. And here's the answer, with live mempool data and a receipt." |
| 2:05-2:20 | **Merchant** tab: revenue, captures, calls per endpoint, capture table | "On the merchant side: revenue, PayPal captures, and calls per endpoint." |
| 2:20-2:30 | Terminal: replay the same order id with curl and get `409 order_already_used`. Then `npm test` passing | "Replay a used payment and it's rejected. Server-side verification, replay protection and budget caps are all tested. PayPal 402: any API can charge any agent, through PayPal." |

Notes:
- If no Anthropic key is set, the run shows "scripted (no LLM key set)" and always pays per call. Record with a key so Claude makes the bundle decision.
- Keep the PayPal approval page on screen for about two seconds. It's the trust moment.
- Don't show `.env` or any credentials.
