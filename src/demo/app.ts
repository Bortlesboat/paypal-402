import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { runAgent } from "../agent/agent.ts";
import { providerFromEnv, type Provider } from "../agent/providers.ts";
import { MockPayPal, paypalFromEnv } from "../paypal/index.ts";
import { walletRouter } from "../wallet/routes.ts";
import { Wallet } from "../wallet/wallet.ts";
import { createMerchantApp } from "./merchant.ts";
import { mockPayPalRouter } from "./mockPages.ts";

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

export interface DemoOptions {
  walletPort?: number;
  merchantPort?: number;
  env?: NodeJS.ProcessEnv;
  provider?: Provider;
}

function listen(app: express.Express, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", (err?: Error) => {
      if (err) return reject(err);
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
    server.on("error", reject);
  });
}

/** Starts the two parties of the demo: the merchant API and the buyer's wallet + dashboard. */
export async function startDemo(opts: DemoOptions = {}) {
  const env = opts.env ?? process.env;
  const walletApp = express();
  walletApp.disable("x-powered-by");
  const walletListening = await listen(walletApp, opts.walletPort ?? 4020);
  const walletUrl = env.PUBLIC_URL || `http://localhost:${walletListening.port}`;

  const paypal = paypalFromEnv(env, walletUrl);
  const isMock = paypal instanceof MockPayPal;
  // Mock PayPal state lives in memory, so mock runs use in-memory databases too.
  const dbFile = (name: string) => (isMock ? ":memory:" : `data/${name}.db`);

  const merchantSecret = env.MERCHANT_SECRET || (isMock ? randomBytes(24).toString("hex") : "");
  if (!merchantSecret) throw new Error("Set MERCHANT_SECRET (any random string, 16+ chars) when using real PayPal credentials");
  const { app: merchantApp, paywall } = createMerchantApp({ paypal, secret: merchantSecret, db: dbFile("merchant"), payeeMerchantId: env.PAYPAL_PAYEE_MERCHANT_ID });
  const merchantListening = await listen(merchantApp, opts.merchantPort ?? 4021);
  const apiOrigin = env.API_ORIGIN || `http://localhost:${merchantListening.port}`;

  const wallet = new Wallet({ paypal, publicUrl: walletUrl, db: dbFile("wallet") });
  const hasPolicy = wallet.db.prepare("SELECT 1 FROM settings WHERE key = 'policy'").get();
  if (!hasPolicy) wallet.setPolicy({ allowedOrigins: [apiOrigin] });

  const agentKey = env.AGENT_KEY || "local-agent-key";
  const { router, grantOwner, isOwner } = walletRouter(wallet, { agentKey });
  const provider = opts.provider ?? providerFromEnv(env, apiOrigin);

  walletApp.get("/", grantOwner, (_req, res) => res.sendFile("index.html", { root: PUBLIC }));
  walletApp.use(express.static(PUBLIC, { index: false }));
  walletApp.use("/wallet", router);
  if (paypal instanceof MockPayPal) walletApp.use("/mock-paypal", mockPayPalRouter(paypal));

  walletApp.get("/dashboard/config", (_req, res) =>
    res.json({ paypalMode: paypal.mode, clientId: paypal.clientId ?? null, apiOrigin, provider: provider.name }),
  );
  // Owner-only view of both parties. In production the merchant view would come from the merchant's own backend.
  walletApp.get("/dashboard/state", (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ error: "owner_session_required" });
    res.json({ wallet: wallet.status(), merchant: paywall.stats(), discovery: paywall.discovery() });
  });

  walletApp.post("/agent/run", express.json(), async (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ error: "owner_session_required" });
    const task = String(req.body?.task ?? "").slice(0, 2000).trim();
    if (!task) return res.status(400).json({ error: "task_required" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("start", { provider: provider.name });
    try {
      const run = await runAgent({ task, provider, walletUrl: `http://localhost:${walletListening.port}`, agentKey, apiOrigin, emit: (e) => send("event", e) });
      send("done", { answer: run.answer, spent: run.spent, budgetLeft: run.budgetLeft, receipts: run.receipts, provider: run.provider });
    } catch (e) {
      send("failed", { message: (e as Error).message });
    }
    res.end();
  });

  return {
    walletUrl,
    walletPort: walletListening.port,
    apiOrigin,
    agentKey,
    paypal,
    wallet,
    paywall,
    provider,
    close: async () => {
      await Promise.all([walletListening.server, merchantListening.server].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
    },
  };
}
