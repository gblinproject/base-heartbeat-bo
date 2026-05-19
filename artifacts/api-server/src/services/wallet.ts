import { createWalletClient, createPublicClient, http, formatEther, parseEther } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";

// __dirname-equivalent for ESM; works both in dev and after esbuild bundling
const __dirname = dirname(fileURLToPath(import.meta.url));
// Fallback path used only if env vars are not set (legacy / local dev without secrets)
const WALLET_DATA_PATH = resolve(__dirname, "../wallet-data.json");
const BASE_RPC = "https://mainnet.base.org";
const NUM_WALLETS = 4;

/**
 * Activity weights per wallet (must sum to 1).
 * W0 keeps the majority as primary; W1-W3 receive proportional shares.
 * Mirror of WALLET_WEIGHTS in bot.ts to avoid circular deps.
 */
const WALLET_WEIGHTS = [0.35, 0.30, 0.20, 0.15];

export const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC),
});

export interface ManagedWallet {
  index: number;
  address: `0x${string}`;
  walletClient: ReturnType<typeof createWalletClient>;
}

let wallets: ManagedWallet[] = [];

export function getOrCreateWallets(): ManagedWallet[] {
  if (wallets.length > 0) return wallets;

  let keys: `0x${string}`[];

  // ── Priority 1: load from Replit Secrets (WALLET_KEY_0 … WALLET_KEY_3) ──────
  const envKeys = [0, 1, 2, 3].map((i) => process.env[`WALLET_KEY_${i}`]).filter(Boolean) as string[];
  if (envKeys.length === NUM_WALLETS) {
    logger.info("Loading wallets from environment secrets...");
    keys = envKeys as `0x${string}`[];

  // ── Priority 2: fallback to wallet-data.json (legacy / local dev) ────────────
  } else if (existsSync(WALLET_DATA_PATH)) {
    logger.info("Loading existing wallets from disk...");
    const raw = readFileSync(WALLET_DATA_PATH, "utf8");
    const data = JSON.parse(raw) as { privateKeys?: string[]; privateKey?: string };

    if (data.privateKeys && data.privateKeys.length >= NUM_WALLETS) {
      keys = data.privateKeys as `0x${string}`[];
    } else {
      const existing: `0x${string}`[] = data.privateKeys
        ? (data.privateKeys as `0x${string}`[])
        : data.privateKey
          ? [data.privateKey as `0x${string}`]
          : [];
      keys = [...existing];
      while (keys.length < NUM_WALLETS) keys.push(generatePrivateKey());
      writeFileSync(WALLET_DATA_PATH, JSON.stringify({ privateKeys: keys }, null, 2), "utf8");
      logger.info({ added: keys.length - existing.length }, "Added new wallets to storage");
    }

  // ── Priority 3: generate brand-new wallets (first run, no secrets set) ───────
  } else {
    logger.info(`Generating ${NUM_WALLETS} new wallets...`);
    keys = Array.from({ length: NUM_WALLETS }, () => generatePrivateKey());
    writeFileSync(WALLET_DATA_PATH, JSON.stringify({ privateKeys: keys }, null, 2), "utf8");
    logger.info("Wallets saved to disk");
  }

  wallets = keys.slice(0, NUM_WALLETS).map((pk, index) => {
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(BASE_RPC),
    });
    return { index, address: account.address, walletClient };
  });

  wallets.forEach((w) => logger.info({ index: w.index, address: w.address }, "Wallet ready"));
  return wallets;
}

export async function getEthBalance(address: `0x${string}`): Promise<number> {
  const wei = await publicClient.getBalance({ address });
  return parseFloat(formatEther(wei));
}

export async function getAllBalances(): Promise<{ index: number; address: string; ethBalance: number; usdBalance: number }[]> {
  const ws = getOrCreateWallets();
  return Promise.all(
    ws.map(async (w) => {
      const eth = await getEthBalance(w.address);
      return { index: w.index, address: w.address, ethBalance: eth, usdBalance: 0 };
    })
  );
}

export async function distributeFunds(ethPriceUsd: number): Promise<void> {
  const ws = getOrCreateWallets();

  // Find the wallet with the most ETH as the distribution source (not always W0)
  const balances = await Promise.all(ws.map(async (w) => ({ w, bal: await getEthBalance(w.address) })));
  const richest  = balances.reduce((a, b) => b.bal > a.bal ? b : a, balances[0]!);
  const primary  = richest.w;
  const primaryBalance = richest.bal;
  const primaryUsd = primaryBalance * ethPriceUsd;

  if (primaryUsd < 2) return; // not enough ETH to distribute from anywhere

  // Keep 50% for the source wallet + 0.001 ETH gas reserve; distribute the rest
  const distributable = primaryBalance * 0.5 - 0.001;
  if (distributable <= 0.0001) return;

  const others = balances.filter((b) => b.w.index !== primary.index);
  const weightSum = others.reduce((s, b) => s + (WALLET_WEIGHTS[b.w.index] ?? 0.25), 0);

  logger.info(
    { source: `W${primary.index}`, distributable: distributable.toFixed(6), primaryBalance: primaryBalance.toFixed(6) },
    "Adaptive fund distribution across wallets..."
  );

  for (const { w: target, bal: targetBalance } of others) {
    if (targetBalance * ethPriceUsd >= 2) continue; // already funded enough

    const proportion = (WALLET_WEIGHTS[target.index] ?? 0.25) / weightSum;
    const send = distributable * proportion;
    if (send <= 0.0001) continue;

    try {
      const hash = await primary.walletClient.sendTransaction({
        to:    target.address,
        value: parseEther(send.toFixed(18)),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      logger.info({ to: target.address, amount: send.toFixed(6), weight: proportion.toFixed(2) }, "Funds distributed (adaptive)");
    } catch (err) {
      logger.warn({ err, to: target.address }, "Failed to distribute funds");
    }
  }
}

/**
 * Tops up a wallet's ETH balance from the richest available wallet so it can
 * pay gas for a sell transaction. No-op if the wallet already has enough ETH.
 */
export async function topUpGasIfNeeded(
  target: ManagedWallet,
  minBalance: number,
  topUpAmount: number,
): Promise<boolean> {
  const currentBal = await getEthBalance(target.address);
  if (currentBal >= minBalance) return true; // already fine

  const ws = getOrCreateWallets();
  const others = ws.filter((w) => w.index !== target.index);
  const bals = await Promise.all(others.map(async (w) => ({ w, bal: await getEthBalance(w.address) })));
  const donor = bals.sort((a, b) => b.bal - a.bal)[0];

  // Donor must have enough to cover the top-up AND keep its own reserve (0.001 ETH)
  if (!donor || donor.bal < topUpAmount + 0.001) {
    logger.warn({ target: target.address, need: topUpAmount, bestDonor: donor?.bal?.toFixed(6) }, "No wallet has enough ETH to top up gas");
    return false;
  }

  try {
    logger.info({ from: `W${donor.w.index}`, to: `W${target.index}`, amount: topUpAmount }, "Gas top-up: sending ETH for sell gas...");
    const hash = await donor.w.walletClient.sendTransaction({
      to:    target.address,
      value: parseEther(topUpAmount.toFixed(18)),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    logger.info({ from: `W${donor.w.index}`, to: `W${target.index}`, amount: topUpAmount }, "Gas top-up confirmed ✅");
    return true;
  } catch (err) {
    logger.warn({ err, target: target.address }, "Gas top-up failed");
    return false;
  }
}
