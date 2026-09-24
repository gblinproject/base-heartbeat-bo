import { Router } from "express";
import {
  getBotState,
  getMetrics,
  triggerBuyNow,
  triggerSellNow,
  triggerBuyUniswap,
  triggerBuyAerodrome,
  triggerSellUniswap,
  triggerSellAerodrome,
  triggerBuyGblinContract,
  triggerSellGblinContract,
  triggerForceSellAll,
} from "../services/bot.js";

const router = Router();

// ── Admin auth for the state-changing endpoints ─────────────────────────────────────
// POST /bot/* moves real funds. It is DISABLED unless BOT_ADMIN_TOKEN is
// set, and requires "Authorization: Bearer <token>" (or "x-admin-token").
const ADMIN_TOKEN = process.env.BOT_ADMIN_TOKEN ?? "";
router.use((req, res, next) => {
  if (req.method === "GET") { next(); return; }
  if (!ADMIN_TOKEN) {
    res.status(403).json({ error: "Endpoint disabilitato: imposta BOT_ADMIN_TOKEN per abilitare i trigger manuali" });
    return;
  }
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const alt = (req.headers["x-admin-token"] as string | undefined) ?? "";
  if (bearer !== ADMIN_TOKEN && alt !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

router.get("/bot/status", (_req, res) => {
  const state = getBotState();

  res.json({
    status: state.status,
    wallets: state.wallets,
    market: {
      ethPriceUsd:     state.ethPriceUsd,
      gblinPriceUsd:   state.gblinPriceUsd,
      totalBalanceUsd: state.wallets.reduce((s, w) => s + w.usdBalance + w.tokenBalanceUsd, 0).toFixed(2),
      totalEthUsd:     state.wallets.reduce((s, w) => s + w.usdBalance, 0).toFixed(2),
      totalGblinUsd:   state.wallets.reduce((s, w) => s + (w.tokenBalanceUsd || 0), 0).toFixed(2),
    },
    heartbeat: {
      targetToken: "0x36C81d7E1966310F305eA637e761Cf77F90852f0",
      buyAmountRangeUsd: { min: 0.50, max: 1.50 },
      dexRouting: "best-execution: Uniswap V3 / Aerodrome V1 / GBLIN contract (quoted in parallel, cheapest wins)",
      sellAmountRange: "15–85% of token holdings",
      sellProbability: "40% base (25–55% dynamic)",
      intervalRangeMin: { night: "60–180", peak: "20–45", normal: "35–90" },
      nextTradeAt: state.nextTradeAt,
      nextIntervalSec: state.nextIntervalSec,
      totalTrades: state.totalTrades,
      totalBuys: state.totalBuys,
      totalSells: state.totalSells,
    },
    lastCheck: state.lastCheck,
    lastTrade: state.lastTrade,
    recentTrades: state.recentTrades,
    shield: {
      lastRefreshAt:   (state as any).shieldLastRefreshAt   ?? null,
      lastRefreshTx:   (state as any).shieldLastRefreshTx   ?? null,
      refreshCount:    (state as any).shieldRefreshCount    ?? 0,
      lastRebalanceAt: (state as any).shieldLastRebalanceAt ?? null,
      lastRebalanceTx: (state as any).shieldLastRebalanceTx ?? null,
    },
    errorMessage: state.errorMessage,
  });
});

router.get("/bot/metrics", (_req, res) => {
  res.json(getMetrics());
});

function guardRunning(res: import("express").Response): boolean {
  if (getBotState().status !== "running") {
    res.status(400).json({ error: "Bot not started yet (wallets not funded)" });
    return false;
  }
  return true;
}

router.post("/bot/buy-now", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY started (random venue) — check /api/bot/status in a few seconds" });
  triggerBuyNow();
});

router.post("/bot/sell-now", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL started (random venue) — check /api/bot/status in a few seconds" });
  triggerSellNow();
});

// ── DEX-specific test endpoints ────────────────────────────────────────────

router.post("/bot/buy-uniswap", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY forced on Uniswap V3 — check /api/bot/status in a few seconds" });
  triggerBuyUniswap();
});

router.post("/bot/buy-aerodrome", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY forced on Aerodrome V1 — check /api/bot/status in a few seconds" });
  triggerBuyAerodrome();
});

router.post("/bot/sell-uniswap", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL forced on Uniswap V3 — check /api/bot/status in a few seconds" });
  triggerSellUniswap();
});

router.post("/bot/sell-aerodrome", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL forced on Aerodrome V1 — check /api/bot/status in a few seconds" });
  triggerSellAerodrome();
});

router.post("/bot/buy-gblin", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY forced on the GBLIN contract — check /api/bot/status in a few seconds" });
  triggerBuyGblinContract();
});

router.post("/bot/sell-gblin", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL forced on the GBLIN contract — check /api/bot/status in a few seconds" });
  triggerSellGblinContract();
});

/**
 * Force-sell from ALL wallets with GBLIN — bypasses running guard and cooldowns.
 * Tops up gas automatically from the richest wallet if a wallet has no ETH.
 * Returns per-wallet results after all sells complete.
 */
router.post("/bot/sell-all", async (_req, res) => {
  try {
    const results = await triggerForceSellAll();
    res.json({ message: "Force-sell-all completato", results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
