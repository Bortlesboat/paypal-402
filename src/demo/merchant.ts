import express from "express";
import type { DatabaseSync } from "node:sqlite";
import type { PayPalAdapter } from "../paypal/types.ts";
import { Paywall } from "../server/paywall.ts";
import { feeRecommendation, mempoolSummary } from "./mempool.ts";

/** The demo merchant: a Bitcoin fee oracle that charges per call through PayPal 402. */
export function createMerchantApp(opts: { paypal: PayPalAdapter; secret: string; db?: string | DatabaseSync; payeeMerchantId?: string }) {
  const paywall = new Paywall({
    paypal: opts.paypal,
    secret: opts.secret,
    db: opts.db,
    merchant: { name: "Fee Oracle", payeeMerchantId: opts.payeeMerchantId },
    bundle: { amount: "1.00", calls: 50 },
  });
  const FEES = { price: "0.05", description: "Fee rate (sat/vB) to confirm a Bitcoin tx within ?target minutes" };
  const MEMPOOL = { price: "0.03", description: "Mempool size, pending fees and fee bands" };
  paywall.register("GET /api/fees/recommend", FEES.price, FEES.description);
  paywall.register("GET /api/mempool/summary", MEMPOOL.price, MEMPOOL.description);

  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/.well-known/paypal402", (_req, res) => res.json(paywall.discovery()));

  app.get("/api/fees/recommend", paywall.charge(FEES), async (req, res, next) => {
    try {
      const target = Math.max(10, Math.min(1440, Number(req.query.target) || 60));
      res.json(await feeRecommendation(target));
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/mempool/summary", paywall.charge(MEMPOOL), async (_req, res, next) => {
    try {
      res.json(await mempoolSummary());
    } catch (e) {
      next(e);
    }
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(502).json({ error: "upstream_error", message: err.message });
  });

  return { app, paywall };
}
