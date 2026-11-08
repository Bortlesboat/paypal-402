import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Wallet } from "./wallet.ts";

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookie(req: Request, name: string): string | undefined {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m?.[1];
}

/**
 * Two principals:
 *  - agent: holds AGENT_KEY. May read status, request payments, store credits. Cannot approve or change policy.
 *  - owner: the human at the dashboard (httpOnly SameSite=Lax session cookie, so PayPal redirects still carry it). Links PayPal, sets policy, approves.
 */
export function walletRouter(wallet: Wallet, opts: { agentKey: string; ownerSession?: string }) {
  const r = express.Router();
  const ownerSession = opts.ownerSession ?? randomBytes(24).toString("base64url");
  r.use(express.json({ limit: "32kb" }));

  const agent = (req: Request, res: Response, next: NextFunction) => {
    const h = req.get("authorization") ?? "";
    if (h.startsWith("Bearer ") && safeEq(h.slice(7), opts.agentKey)) return next();
    if (isOwner(req)) return next();
    res.status(401).json({ error: "agent_key_required" });
  };
  const isOwner = (req: Request) => {
    const c = cookie(req, "p402_owner");
    return Boolean(c && safeEq(c, ownerSession));
  };
  const owner = (req: Request, res: Response, next: NextFunction) => {
    if (isOwner(req)) return next();
    res.status(403).json({ error: "owner_session_required" });
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

  /** Sets the owner cookie. Mounted by the dashboard on GET /. */
  const grantOwner = (_req: Request, res: Response, next: NextFunction) => {
    res.cookie("p402_owner", ownerSession, { httpOnly: true, sameSite: "lax", path: "/" });
    next();
  };

  r.get("/status", agent, (_req, res) => {
    res.json(wallet.status());
  });

  // agent-facing
  r.post("/pay", agent, wrap(async (req, res) => res.json(await wallet.pay(req.body))));
  r.get("/approvals/:id", agent, (req, res) => {
    const a = wallet.getApproval(String(req.params.id));
    if (!a) return res.status(404).json({ error: "not_found" });
    res.json(a);
  });
  r.get("/credits", agent, (req, res) => res.json(wallet.getCredit(String(req.query.origin ?? "")) ?? null));
  r.put("/credits", agent, (req, res) => {
    const { origin, token, remaining } = req.body ?? {};
    if (typeof origin !== "string" || typeof token !== "string" || !Number.isInteger(remaining)) return res.status(400).json({ error: "bad_request" });
    wallet.setCredit(new URL(origin).origin, token, remaining);
    res.json({ ok: true });
  });

  // owner-facing
  r.put("/policy", owner, (req, res) => {
    try {
      res.json(wallet.setPolicy(req.body));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  r.post("/approvals/:id/approve", owner, wrap(async (req, res) => res.json(await wallet.approve(String(req.params.id)))));
  r.post("/approvals/:id/deny", owner, (req, res) => res.json({ ok: wallet.deny(String(req.params.id)) }));
  r.post("/link", owner, wrap(async (_req, res) => res.json(await wallet.startLink())));
  r.post("/link/complete", owner, wrap(async (req, res) => res.json(await wallet.completeLink(String(req.body?.setupTokenId ?? "")))));
  r.post("/unlink", owner, (_req, res) => {
    wallet.unlink();
    res.json({ ok: true });
  });

  // PayPal redirect targets (the browser lands here after approving on PayPal)
  r.get("/link/return", owner, wrap(async (req, res) => {
    const id = String(req.query.approval_token_id ?? req.query.token ?? wallet.lastPendingSetup() ?? "");
    await wallet.completeLink(id);
    res.redirect("/#agent");
  }));
  r.get("/paypal/return", wrap(async (req, res) => {
    await wallet.completeCheckout(String(req.query.token ?? ""));
    res.redirect("/#agent");
  }));
  r.get("/paypal/cancel", (req, res) => {
    wallet.cancelCheckout(String(req.query.token ?? ""));
    res.redirect("/#agent");
  });

  return { router: r, grantOwner, isOwner };
}
