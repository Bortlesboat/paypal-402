import { existsSync } from "node:fs";
import { startDemo } from "./app.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const demo = await startDemo({
  walletPort: Number(process.env.PORT) || 4020,
  merchantPort: Number(process.env.MERCHANT_PORT) || 4021,
});

const mode = demo.paypal.mode === "mock" ? "mock PayPal (set PAYPAL_CLIENT_ID/SECRET for sandbox)" : `PayPal ${demo.paypal.mode}`;
console.log(`
  Dashboard     ${demo.walletUrl}
  Merchant API  ${demo.apiOrigin}   (402-priced: /api/fees/recommend, /api/mempool/summary)
  PayPal        ${mode}
  Agent model   ${demo.provider.name}

  Try the CLI:  npm run agent -- "What fee gets my BTC tx confirmed within an hour?"
`);

const stop = async () => {
  await demo.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
