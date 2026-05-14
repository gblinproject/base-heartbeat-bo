// built 2026-05-14T14:44:47.147Z

// src/app.ts
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { resolve as resolve3, dirname as dirname2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/routes/index.ts
import { Router as Router3 } from "express";

// src/routes/health.ts
import { Router } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
var router = Router();
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});
var health_default = router;

// src/routes/bot.ts
import { Router as Router2 } from "express";

// src/services/bot.ts
import {
  parseEther as parseEther2,
  formatUnits,
  encodeFunctionData
} from "viem";

// src/services/wallet.ts
import { createWalletClient, createPublicClient, http, formatEther, parseEther } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/logger.ts
import pino from "pino";
var isProduction = process.env.NODE_ENV === "production";
var logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']"
  ],
  ...isProduction ? {} : {
    transport: {
      target: "pino-pretty",
      options: { colorize: true }
    }
  }
});

// src/services/wallet.ts
var __dirname = dirname(fileURLToPath(import.meta.url));
var WALLET_DATA_PATH = resolve(__dirname, "../wallet-data.json");
var BASE_RPC = "https://mainnet.base.org";
var NUM_WALLETS = 4;
var WALLET_WEIGHTS = [0.35, 0.3, 0.2, 0.15];
var publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC)
});
var wallets = [];
function getOrCreateWallets() {
  if (wallets.length > 0) return wallets;
  let keys;
  const envKeys = [0, 1, 2, 3].map((i) => process.env[`WALLET_KEY_${i}`]).filter(Boolean);
  if (envKeys.length === NUM_WALLETS) {
    logger.info("Loading wallets from environment secrets...");
    keys = envKeys;
  } else if (existsSync(WALLET_DATA_PATH)) {
    logger.info("Loading existing wallets from disk...");
    const raw = readFileSync(WALLET_DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data.privateKeys && data.privateKeys.length >= NUM_WALLETS) {
      keys = data.privateKeys;
    } else {
      const existing = data.privateKeys ? data.privateKeys : data.privateKey ? [data.privateKey] : [];
      keys = [...existing];
      while (keys.length < NUM_WALLETS) keys.push(generatePrivateKey());
      writeFileSync(WALLET_DATA_PATH, JSON.stringify({ privateKeys: keys }, null, 2), "utf8");
      logger.info({ added: keys.length - existing.length }, "Added new wallets to storage");
    }
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
      transport: http(BASE_RPC)
    });
    return { index, address: account.address, walletClient };
  });
  wallets.forEach((w) => logger.info({ index: w.index, address: w.address }, "Wallet ready"));
  return wallets;
}
async function getEthBalance(address) {
  const wei = await publicClient.getBalance({ address });
  return parseFloat(formatEther(wei));
}
async function distributeFunds(ethPriceUsd) {
  const ws = getOrCreateWallets();
  const primary = ws[0];
  const primaryBalance = await getEthBalance(primary.address);
  const primaryUsd = primaryBalance * ethPriceUsd;
  if (primaryUsd < 5) return;
  const distributable = primaryBalance * 0.6 - 5e-4;
  if (distributable <= 0) return;
  const secondaryWeights = WALLET_WEIGHTS.slice(1);
  const weightSum = secondaryWeights.reduce((a, b) => a + b, 0);
  logger.info(
    { distributable: distributable.toFixed(6), primaryBalance: primaryBalance.toFixed(6) },
    "Adaptive fund distribution across wallets..."
  );
  for (let i = 1; i < ws.length; i++) {
    const targetBalance = await getEthBalance(ws[i].address);
    if (targetBalance * ethPriceUsd >= 2) continue;
    const proportion = (WALLET_WEIGHTS[i] ?? 0) / weightSum;
    const send = distributable * proportion;
    if (send <= 0) continue;
    try {
      const hash = await primary.walletClient.sendTransaction({
        to: ws[i].address,
        value: parseEther(send.toFixed(18))
      });
      await publicClient.waitForTransactionReceipt({ hash });
      logger.info({ to: ws[i].address, amount: send.toFixed(6), weight: proportion.toFixed(2) }, "Funds distributed (adaptive)");
    } catch (err) {
      logger.warn({ err, to: ws[i].address }, "Failed to distribute funds");
    }
  }
}

// src/lib/webhook.ts
function emoji(type, success) {
  if (!success) return "\u274C";
  return type === "buy" ? "\u{1F7E2}" : "\u{1F534}";
}
function buildDiscordPayload(alert) {
  const icon = emoji(alert.type, alert.success);
  const label = alert.type.toUpperCase();
  const color = alert.success ? alert.type === "buy" ? 49775 : 16729156 : 8947848;
  const fields = [
    { name: "Wallet", value: `W${alert.walletIndex} \`${alert.walletAddress.slice(0, 10)}\u2026\``, inline: true },
    { name: "USD", value: `$${alert.usdAmount.toFixed(4)}`, inline: true },
    { name: "ETH", value: `${alert.ethAmount.toFixed(6)}`, inline: true },
    { name: "Tokens", value: alert.tokenAmount ?? "\u2014", inline: true },
    { name: "ETH/USD", value: `$${alert.ethPriceUsd.toFixed(2)}`, inline: true }
  ];
  if (alert.txHash) {
    fields.push({ name: "TX", value: `[${alert.txHash.slice(0, 10)}\u2026](https://basescan.org/tx/${alert.txHash})`, inline: false });
  }
  if (alert.error) {
    fields.push({ name: "Error", value: alert.error.slice(0, 200), inline: false });
  }
  return {
    username: "TradingBot",
    embeds: [{
      title: `${icon} ${label} ${alert.success ? "confirmed" : "FAILED"}`,
      color,
      fields,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      footer: { text: "Base Mainnet" }
    }]
  };
}
function buildTelegramPayload(chatId, alert) {
  const icon = emoji(alert.type, alert.success);
  const label = alert.type.toUpperCase();
  const status = alert.success ? "\u2705 confirmed" : "\u274C FAILED";
  const lines = [
    `${icon} <b>${label} ${status}</b>`,
    `Wallet: W${alert.walletIndex} <code>${alert.walletAddress.slice(0, 12)}\u2026</code>`,
    `Amount: <b>$${alert.usdAmount.toFixed(4)}</b> (${alert.ethAmount.toFixed(6)} ETH)`,
    `Tokens: ${alert.tokenAmount ?? "\u2014"}`,
    `ETH price: $${alert.ethPriceUsd.toFixed(2)}`
  ];
  if (alert.txHash) {
    lines.push(`TX: <a href="https://basescan.org/tx/${alert.txHash}">${alert.txHash.slice(0, 12)}\u2026</a>`);
  }
  if (alert.error) {
    lines.push(`Error: <code>${alert.error.slice(0, 200)}</code>`);
  }
  return {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
}
async function sendTradeAlert(alert) {
  const discordUrl = process.env["DISCORD_WEBHOOK_URL"];
  const telegramToken = process.env["TELEGRAM_BOT_TOKEN"];
  const telegramChat = process.env["TELEGRAM_CHAT_ID"];
  const tasks = [];
  if (discordUrl) {
    tasks.push(
      fetch(discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDiscordPayload(alert))
      }).then((r) => {
        if (!r.ok) throw new Error(`Discord webhook returned ${r.status}`);
        logger.debug("Discord alert sent");
      }).catch((err) => logger.warn({ err }, "Discord webhook failed"))
    );
  }
  if (telegramToken && telegramChat) {
    const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
    tasks.push(
      fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildTelegramPayload(telegramChat, alert))
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`Telegram returned ${r.status}: ${body}`);
        }
        logger.debug("Telegram alert sent");
      }).catch((err) => logger.warn({ err }, "Telegram webhook failed"))
    );
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

// src/services/bot.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync as existsSync2 } from "fs";
import { resolve as resolve2 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var TOKEN_ADDRESS = "0x38DcDB3A381677239BBc652aed9811F2f8496345";
var WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
var UNI_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
var UNI_POOL_FEE = 300;
var AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
var AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
var AERO_POOL = "0x7dcd4f5bcdae0546c84dab54401a93ad6e92ae1b";
var SELL_PROBABILITY_BASE = 0.4;
var SELL_PCT_MIN = 0.15;
var SELL_PCT_MAX = 0.85;
var FUNDED_THRESHOLD_USD = 10;
var POLLING_INTERVAL_MS = 60 * 1e3;
var SELL_COOLDOWN_MS = 45 * 60 * 1e3;
var GBLIN_MIN_ETH_WEI = parseEther2("0.0005");
var GBLIN_CONTRACT_DAILY_BUY_LIMIT = 1;
var BUY_PRESETS = [
  { amount: 0.5, weight: 0.15 },
  { amount: 0.75, weight: 0.25 },
  { amount: 1, weight: 0.3 },
  { amount: 1.25, weight: 0.2 },
  { amount: 1.5, weight: 0.1 }
];
var WALLET_WEIGHTS2 = [0.35, 0.3, 0.2, 0.15];
var MIN_ETH_FOR_SELL = 5e-4;
var SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" }
        ]
      }
    ],
    outputs: [{ name: "amountOut", type: "uint256" }]
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" }
    ],
    outputs: [{ name: "", type: "bytes[]" }]
  },
  {
    name: "unwrapWETH9",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" }
    ],
    outputs: []
  }
];
var AERO_ROUTER_ABI = [
  {
    name: "swapExactETHForTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" }
        ]
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    name: "swapExactTokensForETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" }
        ]
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  }
];
var AERO_AMOUNTS_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" }
        ]
      }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  }
];
var GBLIN_CONTRACT_ABI = [
  {
    name: "buyGBLIN",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "minGblinOut", type: "uint256" }],
    outputs: []
  },
  {
    name: "sellGBLINForEth",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gblinAmount", type: "uint256" },
      { name: "minEthOut", type: "uint256" }
    ],
    outputs: []
  },
  {
    name: "quoteBuyGBLIN",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "ethAmount", type: "uint256" }],
    outputs: [
      { name: "gblinOut", type: "uint256" },
      { name: "wethToReserve", type: "uint256" },
      { name: "fee", type: "uint256" }
    ]
  },
  {
    name: "quoteSellGBLIN",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "gblinAmount", type: "uint256" }],
    outputs: [{ name: "ethOut", type: "uint256" }]
  }
];
var ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }]
  }
];
var state = {
  status: "initializing",
  wallets: [],
  ethPriceUsd: 0,
  gblinPriceUsd: 0,
  lastCheck: null,
  lastTrade: null,
  nextTradeAt: null,
  nextIntervalSec: null,
  totalTrades: 0,
  totalBuys: 0,
  totalSells: 0,
  recentTrades: [],
  errorMessage: null
};
var heartbeatTimeout = null;
var pollingTimer = null;
var isRunning = false;
var prevEthPriceUsd = 0;
var botStartedAt = null;
var lastSellTimestamp = /* @__PURE__ */ new Map();
var lastGblinBuyTimestamp = /* @__PURE__ */ new Map();
var GBLIN_SELL_LOCK_MS = 15e4;
var gblinContractBuyCountToday = 0;
var gblinContractBuyDayKey = "";
var gblinContractBuyUnlockMs = 0;
function getUtcDateKey() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
function refreshGblinDailySlot() {
  const today = getUtcDateKey();
  if (gblinContractBuyDayKey !== today) {
    gblinContractBuyCountToday = 0;
    gblinContractBuyDayKey = today;
    const midnightMs = (/* @__PURE__ */ new Date(today + "T00:00:00Z")).getTime();
    const randomOffMs = Math.floor(Math.random() * 24 * 60 * 60 * 1e3);
    gblinContractBuyUnlockMs = midnightMs + randomOffMs;
    logger.info(
      { date: today, gblinUnlockAt: new Date(gblinContractBuyUnlockMs).toISOString().slice(11, 16) + " UTC" },
      "Daily GBLIN contract buy slot randomized"
    );
  }
}
function isGblinContractBuyAllowed() {
  refreshGblinDailySlot();
  return gblinContractBuyCountToday < GBLIN_CONTRACT_DAILY_BUY_LIMIT && Date.now() >= gblinContractBuyUnlockMs;
}
function recordGblinContractBuyUsed() {
  refreshGblinDailySlot();
  gblinContractBuyCountToday++;
}
var consecutiveBuys = /* @__PURE__ */ new Map();
var walletRebalanceThreshold = /* @__PURE__ */ new Map();
function rollRebalanceThreshold(walletIndex) {
  const t = Math.floor(randomBetween(2, 7));
  walletRebalanceThreshold.set(walletIndex, t);
  return t;
}
function getRebalanceThreshold(walletIndex) {
  if (!walletRebalanceThreshold.has(walletIndex)) rollRebalanceThreshold(walletIndex);
  return walletRebalanceThreshold.get(walletIndex);
}
var __dirname2 = fileURLToPath2(new URL(".", import.meta.url));
var TRADES_LOG = resolve2(__dirname2, "../../trades.json");
function loadPersistedTrades() {
  try {
    if (!existsSync2(TRADES_LOG)) return;
    const raw = readFileSync2(TRADES_LOG, "utf-8");
    const data = JSON.parse(raw);
    state.totalTrades = data.totalTrades ?? 0;
    state.totalBuys = data.totalBuys ?? 0;
    state.totalSells = data.totalSells ?? 0;
    state.recentTrades = (data.trades ?? []).slice(0, 200);
    state.lastTrade = state.recentTrades[0] ?? null;
    logger.info({ totalTrades: state.totalTrades }, "Trade history loaded from disk");
  } catch (err) {
    logger.warn({ err }, "Could not load trade history \u2013 starting fresh");
  }
}
function persistTrades() {
  try {
    const data = {
      totalTrades: state.totalTrades,
      totalBuys: state.totalBuys,
      totalSells: state.totalSells,
      trades: state.recentTrades.slice(0, 200)
    };
    writeFileSync2(TRADES_LOG, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.warn({ err }, "Could not persist trades to disk");
  }
}
function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getIntervalMs() {
  const now = /* @__PURE__ */ new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const isWeekend = day === 0 || day === 6;
  const isNight = hour < 6;
  const isPeak = hour >= 12 && hour < 22;
  let minMs;
  let maxMs;
  if (isNight) {
    minMs = 45 * 6e4;
    maxMs = 120 * 6e4;
  } else if (isPeak) {
    minMs = 8 * 6e4;
    maxMs = 22 * 6e4;
  } else {
    minMs = 18 * 6e4;
    maxMs = 45 * 6e4;
  }
  if (isWeekend) {
    minMs = Math.round(minMs * 1.3);
    maxMs = Math.round(maxMs * 1.3);
  }
  return randomBetween(minMs, maxMs);
}
function currentSellProbability(ethPriceUsd) {
  if (prevEthPriceUsd === 0) return SELL_PROBABILITY_BASE;
  const pct = (ethPriceUsd - prevEthPriceUsd) / prevEthPriceUsd;
  if (pct > 0.015) return 0.55;
  if (pct < -0.015) return 0.25;
  return SELL_PROBABILITY_BASE;
}
function selectWalletIndex() {
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < WALLET_WEIGHTS2.length; i++) {
    cumulative += WALLET_WEIGHTS2[i];
    if (r < cumulative) return i;
  }
  return WALLET_WEIGHTS2.length - 1;
}
function selectBestFundedWallet() {
  const ws = getOrCreateWallets();
  return ws.reduce((best, w) => w.ethBalance > best.ethBalance ? w : best, ws[0]);
}
function selectBuyAmountUsd() {
  const r = Math.random();
  let cumulative = 0;
  let base2 = BUY_PRESETS[BUY_PRESETS.length - 1].amount;
  for (const preset of BUY_PRESETS) {
    cumulative += preset.weight;
    if (r < cumulative) {
      base2 = preset.amount;
      break;
    }
  }
  const noise = (Math.random() - 0.5) * 0.12;
  return Math.max(0.45, Math.min(1.55, base2 + noise));
}
async function applyJitter(manual = false) {
  if (manual) return;
  const ms = Math.random() < 0.7 ? randomBetween(0, 3e4) : randomBetween(6e4, 18e4);
  logger.info({ jitterSec: (ms / 1e3).toFixed(1) }, "Jitter delay before trade");
  await sleep(ms);
}
async function getVariedGasPrice() {
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 1000000n;
    const tipMultiplier = randomBetween(0.5, 1.5);
    const tip = BigInt(Math.round(Number(baseFee) * tipMultiplier));
    return baseFee + tip;
  } catch {
    return 1500000n;
  }
}
async function getEthPriceUsd() {
  try {
    const res = await fetch(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      { signal: AbortSignal.timeout(8e3) }
    );
    const data = await res.json();
    const price = parseFloat(data?.data?.amount ?? "0");
    if (price > 100) return price;
  } catch {
  }
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
      { signal: AbortSignal.timeout(8e3) }
    );
    const data = await res.json();
    const price = parseFloat(data?.price ?? "0");
    if (price > 100) return price;
  } catch {
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(1e4) }
    );
    const data = await res.json();
    const price = data?.ethereum?.usd ?? 0;
    if (price > 100) return price;
  } catch {
  }
  return state.ethPriceUsd || 2500;
}
async function getGblinPriceUsd() {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`,
      { signal: AbortSignal.timeout(8e3) }
    );
    const data = await res.json();
    const pairs = (data?.pairs ?? []).filter((p) => p.priceUsd && Number(p.priceUsd) > 0).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : 0;
    if (price > 0) state.gblinPriceUsd = price;
    return price || state.gblinPriceUsd || 0;
  } catch {
    return state.gblinPriceUsd || 0;
  }
}
var TOKEN_DECIMALS = 18;
async function getTokenBalance(address) {
  const raw = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address]
  });
  return { raw, human: formatUnits(raw, TOKEN_DECIMALS) };
}
var AERO_ROUTE_BUY = [{ from: WETH_ADDRESS, to: TOKEN_ADDRESS, stable: false, factory: AERO_FACTORY }];
var AERO_ROUTE_SELL = [{ from: TOKEN_ADDRESS, to: WETH_ADDRESS, stable: false, factory: AERO_FACTORY }];
async function quoteAerodromeBuy(ethWei) {
  const amounts = await publicClient.readContract({
    address: AERO_ROUTER,
    abi: AERO_AMOUNTS_ABI,
    functionName: "getAmountsOut",
    args: [ethWei, AERO_ROUTE_BUY]
  });
  return amounts[amounts.length - 1];
}
async function quoteAerodromeSell(gblinWei) {
  const amounts = await publicClient.readContract({
    address: AERO_ROUTER,
    abi: AERO_AMOUNTS_ABI,
    functionName: "getAmountsOut",
    args: [gblinWei, AERO_ROUTE_SELL]
  });
  return amounts[amounts.length - 1];
}
async function quoteGblinContractBuy(ethWei) {
  const safeEthWei = ethWei < GBLIN_MIN_ETH_WEI ? GBLIN_MIN_ETH_WEI : ethWei;
  const [gblinOut] = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: GBLIN_CONTRACT_ABI,
    functionName: "quoteBuyGBLIN",
    args: [safeEthWei]
  });
  return gblinOut * 999n / 1000n;
}
async function quoteGblinContractSell(gblinWei) {
  return publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: GBLIN_CONTRACT_ABI,
    functionName: "quoteSellGBLIN",
    args: [gblinWei]
  });
}
async function findBestBuyVenue(ethWei, excludeGblin = false) {
  if (excludeGblin) {
    logger.info(
      { gblinCountToday: gblinContractBuyCountToday, limit: GBLIN_CONTRACT_DAILY_BUY_LIMIT },
      "GBLIN contract daily limit reached \u2013 Aerodrome only"
    );
  }
  const [aero, gblin] = await Promise.allSettled([
    quoteAerodromeBuy(ethWei).then((a) => ({ venue: "aerodrome", label: "Aerodrome V1", amountOut: a })),
    ...excludeGblin ? [] : [quoteGblinContractBuy(ethWei).then((a) => ({ venue: "gblin", label: "GBLIN contract", amountOut: a }))]
  ]);
  const results = [];
  if (aero.status === "fulfilled") results.push(aero.value);
  if (!excludeGblin && gblin?.status === "fulfilled") results.push(gblin.value);
  if (results.length === 0) throw new Error("All buy venues failed to quote");
  results.sort((a, b) => b.amountOut > a.amountOut ? 1 : -1);
  logger.info(
    { quotes: results.map((r) => `${r.label}: ${formatUnits(r.amountOut, TOKEN_DECIMALS)} GBLIN`), winner: results[0].label },
    "Best execution BUY quote"
  );
  return results[0];
}
async function findBestSellVenue(gblinWei, walletIndex) {
  const gblinLocked = walletIndex !== void 0 && Date.now() - (lastGblinBuyTimestamp.get(walletIndex) ?? 0) < GBLIN_SELL_LOCK_MS;
  if (gblinLocked) {
    const secsLeft = Math.ceil((GBLIN_SELL_LOCK_MS - (Date.now() - (lastGblinBuyTimestamp.get(walletIndex) ?? 0))) / 1e3);
    logger.info({ walletIndex, secsLeft }, "GBLIN sell lock active \u2013 excluding GBLIN from sell venues");
  }
  const [aero, gblin] = await Promise.allSettled([
    quoteAerodromeSell(gblinWei).then((a) => ({ venue: "aerodrome", label: "Aerodrome V1", amountOut: a })),
    ...gblinLocked ? [] : [quoteGblinContractSell(gblinWei).then((a) => ({ venue: "gblin", label: "GBLIN contract", amountOut: a }))]
  ]);
  const results = [];
  if (aero.status === "fulfilled") results.push(aero.value);
  if (!gblinLocked && gblin?.status === "fulfilled") results.push(gblin.value);
  if (results.length === 0) throw new Error("All sell venues failed to quote");
  results.sort((a, b) => b.amountOut > a.amountOut ? 1 : -1);
  logger.info(
    { quotes: results.map((r) => `${r.label}: ${formatUnits(r.amountOut, 18)} ETH`), winner: results[0].label },
    "Best execution SELL quote"
  );
  return results[0];
}
function encodeExactInputSingle(params) {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.fee,
      recipient: params.recipient,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96: 0n
    }]
  });
}
function encodeUnwrapWETH9(recipient) {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "unwrapWETH9",
    args: [0n, recipient]
  });
}
async function executeBuy(wallet, ethPriceUsd, manual = false, ethWeiIn, usdAmountIn) {
  const precomputed = ethWeiIn !== void 0 && usdAmountIn !== void 0;
  if (!precomputed) await applyJitter(manual);
  const usdAmount = precomputed ? usdAmountIn : selectBuyAmountUsd();
  const ethWei = precomputed ? ethWeiIn : parseEther2((usdAmount / ethPriceUsd).toFixed(18));
  const ethAmount = Number(ethWei) / 1e18;
  const deadline = BigInt(Math.floor(Date.now() / 1e3) + 300);
  const record = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "buy",
    walletIndex: wallet.index,
    walletAddress: wallet.address,
    ethAmount,
    usdAmount,
    ethPriceUsd,
    txHash: null,
    success: false,
    dex: "Uniswap V3"
  };
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < ethAmount + 1e-4) {
    record.error = `Low ETH balance: ${ethBalance.toFixed(6)} ETH`;
    logger.warn({ wallet: wallet.address, balance: ethBalance }, "Skipping buy \u2013 low ETH");
    return record;
  }
  logger.info(
    { wallet: wallet.address, usd: usdAmount.toFixed(4), eth: ethAmount.toFixed(8) },
    "Executing BUY..."
  );
  try {
    logger.info({ wallet: wallet.address, usd: usdAmount.toFixed(4) }, "Sending ETH \u2192 TOKEN swap (1 tx)...");
    const gasPrice = await getVariedGasPrice();
    const hash = await wallet.walletClient.writeContract({
      address: UNI_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: WETH_ADDRESS,
        tokenOut: TOKEN_ADDRESS,
        fee: UNI_POOL_FEE,
        recipient: wallet.address,
        amountIn: ethWei,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n
      }],
      value: ethWei,
      gasPrice
    });
    const tokBefore = await getTokenBalance(wallet.address);
    await publicClient.waitForTransactionReceipt({ hash });
    const tokAfter = await getTokenBalance(wallet.address);
    record.txHash = hash;
    record.tokenAmount = formatUnits(
      tokAfter.raw > tokBefore.raw ? tokAfter.raw - tokBefore.raw : 0n,
      TOKEN_DECIMALS
    );
    record.success = true;
    consecutiveBuys.set(wallet.index, (consecutiveBuys.get(wallet.index) ?? 0) + 1);
    logger.info(
      { hash, usd: usdAmount.toFixed(4), gblinReceived: record.tokenAmount, consecutiveBuys: consecutiveBuys.get(wallet.index) },
      "BUY confirmed \u2705"
    );
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "BUY failed");
  }
  sendTradeAlert(record).catch(() => {
  });
  return record;
}
async function executeBuyAerodrome(wallet, ethPriceUsd, manual = false, ethWeiIn, usdAmountIn) {
  const precomputed = ethWeiIn !== void 0 && usdAmountIn !== void 0;
  if (!precomputed) await applyJitter(manual);
  const usdAmount = precomputed ? usdAmountIn : selectBuyAmountUsd();
  const ethWei = precomputed ? ethWeiIn : parseEther2((usdAmount / ethPriceUsd).toFixed(18));
  const ethAmount = Number(ethWei) / 1e18;
  const deadline = BigInt(Math.floor(Date.now() / 1e3) + 300);
  const record = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "buy",
    walletIndex: wallet.index,
    walletAddress: wallet.address,
    ethAmount,
    usdAmount,
    tokenAmount: "0",
    ethPriceUsd,
    txHash: null,
    success: false,
    dex: "Aerodrome"
  };
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < ethAmount + 1e-4) {
    record.error = `Low ETH balance: ${ethBalance.toFixed(6)} ETH`;
    return record;
  }
  logger.info({ wallet: wallet.address, usd: usdAmount.toFixed(4), dex: "Aerodrome" }, "Executing BUY (Aerodrome)...");
  try {
    const gasPrice = await getVariedGasPrice();
    const hash = await wallet.walletClient.writeContract({
      address: AERO_ROUTER,
      abi: AERO_ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [
        0n,
        [{ from: WETH_ADDRESS, to: TOKEN_ADDRESS, stable: false, factory: AERO_FACTORY }],
        wallet.address,
        deadline
      ],
      value: ethWei,
      gasPrice
    });
    const tokBefore = await getTokenBalance(wallet.address);
    await publicClient.waitForTransactionReceipt({ hash });
    const tokAfter = await getTokenBalance(wallet.address);
    record.txHash = hash;
    record.tokenAmount = formatUnits(
      tokAfter.raw > tokBefore.raw ? tokAfter.raw - tokBefore.raw : 0n,
      TOKEN_DECIMALS
    );
    record.success = true;
    consecutiveBuys.set(wallet.index, (consecutiveBuys.get(wallet.index) ?? 0) + 1);
    logger.info({ hash, usd: usdAmount.toFixed(4), gblinReceived: record.tokenAmount, dex: "Aerodrome" }, "BUY Aerodrome confirmed \u2705");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "BUY Aerodrome failed");
  }
  sendTradeAlert(record).catch(() => {
  });
  return record;
}
async function executeSellAerodrome(wallet, ethPriceUsd, manual = false, sellAmountIn) {
  const precomputed = sellAmountIn !== void 0;
  if (!precomputed) await applyJitter(manual);
  const { raw: tokenBalanceRaw, human: tokenBalanceHuman } = await getTokenBalance(wallet.address);
  const record = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "sell",
    walletIndex: wallet.index,
    walletAddress: wallet.address,
    ethAmount: 0,
    usdAmount: 0,
    tokenAmount: "0",
    ethPriceUsd,
    txHash: null,
    success: false,
    dex: "Aerodrome"
  };
  if (tokenBalanceRaw === 0n) {
    record.error = "No token balance to sell";
    return record;
  }
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < MIN_ETH_FOR_SELL) {
    record.error = `Low ETH for gas: ${ethBalance.toFixed(6)} ETH (need ${MIN_ETH_FOR_SELL})`;
    return record;
  }
  const lastSell = lastSellTimestamp.get(wallet.index) ?? 0;
  if (!manual && Date.now() - lastSell < SELL_COOLDOWN_MS) {
    record.error = "Sell cooldown active for this wallet";
    return record;
  }
  const sellPct = precomputed ? null : randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
  const sellAmount = precomputed ? sellAmountIn : tokenBalanceRaw * BigInt(Math.floor(sellPct * 1e4)) / 10000n;
  if (sellAmount === 0n) {
    record.error = "Sell amount too small";
    return record;
  }
  record.tokenAmount = formatUnits(sellAmount, TOKEN_DECIMALS);
  logger.info({
    wallet: wallet.address,
    tokenBal: tokenBalanceHuman,
    sellPct: sellPct !== null ? (sellPct * 100).toFixed(1) + "%" : "pre-computed",
    dex: "Aerodrome"
  }, "Executing SELL (Aerodrome)...");
  const deadline = BigInt(Math.floor(Date.now() / 1e3) + 300);
  try {
    const approveGasPrice = await getVariedGasPrice();
    const approveHash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [AERO_ROUTER, sellAmount],
      gasPrice: approveGasPrice
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") throw new Error(`approve reverted (${approveHash})`);
    await sleep(2e3);
    const ethBeforeSwap = await publicClient.getBalance({ address: wallet.address });
    const swapGasPrice = await getVariedGasPrice();
    const swapHash = await wallet.walletClient.writeContract({
      address: AERO_ROUTER,
      abi: AERO_ROUTER_ABI,
      functionName: "swapExactTokensForETH",
      args: [
        sellAmount,
        0n,
        [{ from: TOKEN_ADDRESS, to: WETH_ADDRESS, stable: false, factory: AERO_FACTORY }],
        wallet.address,
        deadline
      ],
      gasPrice: swapGasPrice
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const ethAfterSwap = await publicClient.getBalance({ address: wallet.address });
    const gasCostWei = swapReceipt.gasUsed * (swapReceipt.effectiveGasPrice ?? swapGasPrice);
    const ethReceivedWei = ethAfterSwap + gasCostWei > ethBeforeSwap ? ethAfterSwap + gasCostWei - ethBeforeSwap : 0n;
    const ethReceived = Number(ethReceivedWei) / 1e18;
    record.txHash = swapHash;
    record.ethAmount = ethReceived;
    record.usdAmount = ethReceived * ethPriceUsd;
    record.success = true;
    lastSellTimestamp.set(wallet.index, Date.now());
    consecutiveBuys.set(wallet.index, 0);
    rollRebalanceThreshold(wallet.index);
    logger.info({ swapHash, tokensSold: record.tokenAmount, dex: "Aerodrome" }, "SELL Aerodrome confirmed \u2705");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "SELL Aerodrome failed");
  }
  sendTradeAlert(record).catch(() => {
  });
  return record;
}
async function executeSell(wallet, ethPriceUsd, manual = false, sellAmountIn) {
  const precomputed = sellAmountIn !== void 0;
  if (!precomputed) await applyJitter(manual);
  const { raw: tokenBalanceRaw, human: tokenBalanceHuman } = await getTokenBalance(wallet.address);
  const record = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "sell",
    walletIndex: wallet.index,
    walletAddress: wallet.address,
    ethAmount: 0,
    usdAmount: 0,
    tokenAmount: "0",
    ethPriceUsd,
    txHash: null,
    success: false,
    dex: "Uniswap V3"
  };
  if (tokenBalanceRaw === 0n) {
    record.error = "No token balance to sell";
    logger.warn({ wallet: wallet.address }, "Skipping sell \u2013 no token balance");
    return record;
  }
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < MIN_ETH_FOR_SELL) {
    record.error = `Low ETH for gas: ${ethBalance.toFixed(6)} ETH (need ${MIN_ETH_FOR_SELL})`;
    logger.warn(
      { wallet: wallet.address, ethBalance: ethBalance.toFixed(6), minRequired: MIN_ETH_FOR_SELL },
      "Skipping sell \u2013 insufficient ETH for gas"
    );
    return record;
  }
  const lastSell = lastSellTimestamp.get(wallet.index) ?? 0;
  if (!manual && Date.now() - lastSell < SELL_COOLDOWN_MS) {
    record.error = "Sell cooldown active for this wallet";
    logger.info(
      { wallet: wallet.address, cooldownRemaining: Math.round((SELL_COOLDOWN_MS - (Date.now() - lastSell)) / 6e4) + " min" },
      "Skipping sell \u2013 cooldown"
    );
    return record;
  }
  const sellPct = precomputed ? null : randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
  const sellAmount = precomputed ? sellAmountIn : tokenBalanceRaw * BigInt(Math.floor(sellPct * 1e4)) / 10000n;
  if (sellAmount === 0n) {
    record.error = "Sell amount too small";
    return record;
  }
  record.tokenAmount = formatUnits(sellAmount, TOKEN_DECIMALS);
  logger.info(
    {
      wallet: wallet.address,
      tokenBal: tokenBalanceHuman,
      sellPct: sellPct !== null ? (sellPct * 100).toFixed(1) + "%" : "pre-computed",
      sellAmount: record.tokenAmount
    },
    "Executing SELL (approve \u2192 multicall swap+unwrap)..."
  );
  const deadline = BigInt(Math.floor(Date.now() / 1e3) + 300);
  try {
    logger.info({ wallet: wallet.address }, "Step 1: approving SwapRouter02 for TOKEN...");
    const approveGasPrice = await getVariedGasPrice();
    const approveHash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [UNI_ROUTER, sellAmount],
      gasPrice: approveGasPrice
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") {
      throw new Error(`TOKEN.approve reverted (hash ${approveHash})`);
    }
    logger.info({ approveHash }, "Approval confirmed \u2705");
    await sleep(2e3);
    logger.info({ wallet: wallet.address }, "Step 2: swap TOKEN\u2192ETH via multicall...");
    const swapCalldata = encodeExactInputSingle({
      tokenIn: TOKEN_ADDRESS,
      tokenOut: WETH_ADDRESS,
      fee: UNI_POOL_FEE,
      recipient: UNI_ROUTER,
      // router receives WETH, then unwraps to ETH
      amountIn: sellAmount,
      amountOutMinimum: 0n
    });
    const unwrapCalldata = encodeUnwrapWETH9(wallet.address);
    const ethBeforeSwap = await publicClient.getBalance({ address: wallet.address });
    const swapGasPrice = await getVariedGasPrice();
    const swapHash = await wallet.walletClient.writeContract({
      address: UNI_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: "multicall",
      args: [deadline, [swapCalldata, unwrapCalldata]],
      value: 0n,
      gas: 400000n,
      gasPrice: swapGasPrice
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const ethAfterSwap = await publicClient.getBalance({ address: wallet.address });
    const gasCostWei = swapReceipt.gasUsed * (swapReceipt.effectiveGasPrice ?? swapGasPrice);
    const ethReceivedWei = ethAfterSwap + gasCostWei > ethBeforeSwap ? ethAfterSwap + gasCostWei - ethBeforeSwap : 0n;
    const ethReceived = Number(ethReceivedWei) / 1e18;
    record.txHash = swapHash;
    record.ethAmount = ethReceived;
    record.usdAmount = ethReceived * ethPriceUsd;
    record.success = true;
    lastSellTimestamp.set(wallet.index, Date.now());
    consecutiveBuys.set(wallet.index, 0);
    const newThreshold = rollRebalanceThreshold(wallet.index);
    logger.info({ swapHash, tokensSold: record.tokenAmount, nextRebalanceAt: newThreshold + " buys" }, "SELL confirmed \u2705");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "SELL failed");
  }
  sendTradeAlert(record).catch(() => {
  });
  return record;
}
async function executeBuyGblinContract(wallet, ethPriceUsd, ethWei, usdAmount, manual = false) {
  const ethAmount = Number(ethWei) / 1e18;
  const record = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "buy",
    walletIndex: wallet.index,
    walletAddress: wallet.address,
    ethAmount,
    usdAmount,
    tokenAmount: "0",
    ethPriceUsd,
    txHash: null,
    success: false,
    dex: "GBLIN"
  };
  const safeEthWei = ethWei < GBLIN_MIN_ETH_WEI ? GBLIN_MIN_ETH_WEI : ethWei;
  const safeEthAmount = Number(safeEthWei) / 1e18;
  if (safeEthWei !== ethWei) {
    logger.info({ original: ethAmount.toFixed(6), clamped: safeEthAmount.toFixed(6) }, "GBLIN buy clamped to minimum 0.0005 ETH");
  }
  logger.info({ wallet: wallet.address, usd: usdAmount.toFixed(4), ethWei: safeEthWei.toString(), dex: "GBLIN contract" }, "Executing BUY (GBLIN contract)...");
  try {
    const gasPrice = await getVariedGasPrice();
    const hash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi: GBLIN_CONTRACT_ABI,
      functionName: "buyGBLIN",
      args: [0n],
      // minGblinOut = 0 (best-execution already verified)
      value: safeEthWei,
      gas: 600000n,
      // buyGBLIN does internal swaps — needs more gas
      gasPrice
    });
    const tokBefore = await getTokenBalance(wallet.address);
    await publicClient.waitForTransactionReceipt({ hash });
    const tokAfter = await getTokenBalance(wallet.address);
    record.txHash = hash;
    record.tokenAmount = formatUnits(
      tokAfter.raw > tokBefore.raw ? tokAfter.raw - tokBefore.raw : 0n,
      TOKEN_DECIMALS
    );
    record.success = true;
    consecutiveBuys.set(wallet.index, (consecutiveBuys.get(wallet.index) ?? 0) + 1);
    lastGblinBuyTimestamp.set(wallet.index, Date.now());
    recordGblinContractBuyUsed();
    logger.info({ hash, usd: usdAmount.toFixed(4), gblinReceived: record.tokenAmount, dex: "GBLIN contract", gblinBuysToday: gblinContractBuyCountToday }, "BUY GBLIN contract confirmed \u2705");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "BUY GBLIN contract failed");
  }
  sendTradeAlert(record).catch(() => {
  });
  return record;
}
async function executeSellGblinContract(wallet, ethPriceUsd, sellAmount, manual = false) {
  const record = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "sell",
    walletIndex: wallet.index,
    walletAddress: wallet.address,
    ethAmount: 0,
    usdAmount: 0,
    tokenAmount: formatUnits(sellAmount, TOKEN_DECIMALS),
    ethPriceUsd,
    txHash: null,
    success: false,
    dex: "GBLIN"
  };
  logger.info({ wallet: wallet.address, tokens: record.tokenAmount, dex: "GBLIN contract" }, "Executing SELL (GBLIN contract)...");
  try {
    const approveGasPrice = await getVariedGasPrice();
    const approveHash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [TOKEN_ADDRESS, sellAmount],
      gasPrice: approveGasPrice
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") throw new Error(`approve reverted (${approveHash})`);
    await sleep(2e3);
    const ethBeforeSwap = await publicClient.getBalance({ address: wallet.address });
    const swapGasPrice = await getVariedGasPrice();
    const swapHash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi: GBLIN_CONTRACT_ABI,
      functionName: "sellGBLINForEth",
      args: [sellAmount, 0n],
      // minEthOut = 0 (best-execution already verified)
      gasPrice: swapGasPrice
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const ethAfterSwap = await publicClient.getBalance({ address: wallet.address });
    const gasCostWei = swapReceipt.gasUsed * (swapReceipt.effectiveGasPrice ?? swapGasPrice);
    const ethReceivedWei = ethAfterSwap + gasCostWei > ethBeforeSwap ? ethAfterSwap + gasCostWei - ethBeforeSwap : 0n;
    const ethReceived = Number(ethReceivedWei) / 1e18;
    record.txHash = swapHash;
    record.ethAmount = ethReceived;
    record.usdAmount = ethReceived * ethPriceUsd;
    record.success = true;
    lastSellTimestamp.set(wallet.index, Date.now());
    consecutiveBuys.set(wallet.index, 0);
    rollRebalanceThreshold(wallet.index);
    logger.info({ swapHash, tokensSold: record.tokenAmount, dex: "GBLIN contract" }, "SELL GBLIN contract confirmed \u2705");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "SELL GBLIN contract failed");
  }
  sendTradeAlert(record).catch(() => {
  });
  return record;
}
async function bestExecutionBuy(wallet, ethPriceUsd, manual = false) {
  await applyJitter(manual);
  const usdAmount = selectBuyAmountUsd();
  const ethAmount = usdAmount / ethPriceUsd;
  const ethWei = parseEther2(ethAmount.toFixed(18));
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < ethAmount + 2e-4) {
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: "buy",
      walletIndex: wallet.index,
      walletAddress: wallet.address,
      ethAmount,
      usdAmount,
      tokenAmount: "0",
      ethPriceUsd,
      txHash: null,
      success: false,
      error: `Low ETH balance: ${ethBalance.toFixed(6)} ETH`
    };
  }
  const gblinAllowed = isGblinContractBuyAllowed();
  const best = await findBestBuyVenue(ethWei, !gblinAllowed).catch(() => null);
  if (!best) {
    logger.warn("All buy quotes failed \u2013 falling back to Aerodrome");
    return executeBuyAerodrome(wallet, ethPriceUsd, true, ethWei, usdAmount);
  }
  if (best.venue === "gblin") return executeBuyGblinContract(wallet, ethPriceUsd, ethWei, usdAmount, manual);
  return executeBuyAerodrome(wallet, ethPriceUsd, manual, ethWei, usdAmount);
}
async function bestExecutionSell(wallet, ethPriceUsd, manual = false) {
  await applyJitter(manual);
  const { raw: tokenBalanceRaw, human: tokenBalanceHuman } = await getTokenBalance(wallet.address);
  if (tokenBalanceRaw === 0n) {
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: "sell",
      walletIndex: wallet.index,
      walletAddress: wallet.address,
      ethAmount: 0,
      usdAmount: 0,
      tokenAmount: "0",
      ethPriceUsd,
      txHash: null,
      success: false,
      error: "No token balance to sell"
    };
  }
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < MIN_ETH_FOR_SELL) {
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: "sell",
      walletIndex: wallet.index,
      walletAddress: wallet.address,
      ethAmount: 0,
      usdAmount: 0,
      tokenAmount: "0",
      ethPriceUsd,
      txHash: null,
      success: false,
      error: `Low ETH for gas: ${ethBalance.toFixed(6)} ETH (need ${MIN_ETH_FOR_SELL})`
    };
  }
  const lastSell = lastSellTimestamp.get(wallet.index) ?? 0;
  if (!manual && Date.now() - lastSell < SELL_COOLDOWN_MS) {
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: "sell",
      walletIndex: wallet.index,
      walletAddress: wallet.address,
      ethAmount: 0,
      usdAmount: 0,
      tokenAmount: "0",
      ethPriceUsd,
      txHash: null,
      success: false,
      error: "Sell cooldown active for this wallet"
    };
  }
  const sellPct = randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
  const sellAmount = tokenBalanceRaw * BigInt(Math.floor(sellPct * 1e4)) / 10000n;
  if (sellAmount === 0n) {
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: "sell",
      walletIndex: wallet.index,
      walletAddress: wallet.address,
      ethAmount: 0,
      usdAmount: 0,
      tokenAmount: "0",
      ethPriceUsd,
      txHash: null,
      success: false,
      error: "Sell amount too small"
    };
  }
  logger.info({ wallet: wallet.address, tokenBal: tokenBalanceHuman, sellPct: (sellPct * 100).toFixed(1) + "%" }, "Quoting best sell venue...");
  const best = await findBestSellVenue(sellAmount, wallet.index).catch(() => null);
  if (!best) {
    logger.warn("All sell quotes failed \u2013 falling back to Aerodrome");
    return executeSellAerodrome(wallet, ethPriceUsd, true, sellAmount);
  }
  if (best.venue === "gblin") return executeSellGblinContract(wallet, ethPriceUsd, sellAmount, manual);
  return executeSellAerodrome(wallet, ethPriceUsd, manual, sellAmount);
}
var SKIP_ERRORS = [
  "No token balance",
  "Low ETH balance",
  "Sell amount too small",
  "cooldown"
];
async function withRetry(fn, maxAttempts = 3) {
  let lastRecord;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastRecord = await fn();
    if (lastRecord.success) return lastRecord;
    const isSkip = SKIP_ERRORS.some((s) => lastRecord.error?.includes(s));
    if (isSkip || attempt === maxAttempts) return lastRecord;
    const waitMs = randomBetween(3e4, 6e4);
    logger.warn(
      { attempt, maxAttempts, waitSec: (waitMs / 1e3).toFixed(0), error: lastRecord.error?.slice(0, 80) },
      "Trade failed \u2013 retrying..."
    );
    await sleep(waitMs);
  }
  return lastRecord;
}
async function executeTrade(ethPriceUsd) {
  const wallets2 = getOrCreateWallets();
  if (Math.random() < 0.12) {
    logger.info("Skipping trade this cycle (human-like hesitation)");
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: "buy",
      walletIndex: 0,
      walletAddress: wallets2[0].address,
      ethAmount: 0,
      usdAmount: 0,
      tokenAmount: "0",
      ethPriceUsd,
      txHash: null,
      success: false,
      error: "skipped"
    };
  }
  const rebalanceCandidate = wallets2.find(
    (w) => (consecutiveBuys.get(w.index) ?? 0) >= getRebalanceThreshold(w.index)
  );
  if (rebalanceCandidate) {
    logger.info(
      {
        wallet: rebalanceCandidate.address,
        consecutiveBuys: consecutiveBuys.get(rebalanceCandidate.index),
        threshold: getRebalanceThreshold(rebalanceCandidate.index)
      },
      "Rebalance: forcing SELL (best execution)"
    );
    return withRetry(() => bestExecutionSell(rebalanceCandidate, ethPriceUsd));
  }
  const sellProb = currentSellProbability(ethPriceUsd);
  const isSell = Math.random() < sellProb;
  if (isSell) {
    const eligible = wallets2.filter((w) => {
      const lastSell = lastSellTimestamp.get(w.index) ?? 0;
      return Date.now() - lastSell >= SELL_COOLDOWN_MS;
    });
    if (eligible.length > 0) {
      const eligibleWeights = eligible.map((w) => WALLET_WEIGHTS2[w.index] ?? 0.25);
      const totalW = eligibleWeights.reduce((a, b) => a + b, 0);
      const r = Math.random() * totalW;
      let cum = 0;
      let chosen = eligible[0];
      for (let i = 0; i < eligible.length; i++) {
        cum += eligibleWeights[i];
        if (r < cum) {
          chosen = eligible[i];
          break;
        }
      }
      logger.info({ sellProbability: (sellProb * 100).toFixed(0) + "%" }, "Trade type: SELL (best execution)");
      return withRetry(() => bestExecutionSell(chosen, ethPriceUsd));
    }
    logger.info("All wallets in sell cooldown \u2013 falling back to BUY");
  }
  const walletIdx = selectWalletIndex();
  const wallet = wallets2[walletIdx];
  logger.info({ sellProbability: (sellProb * 100).toFixed(0) + "%" }, "Trade type: BUY (best execution)");
  return withRetry(() => bestExecutionBuy(wallet, ethPriceUsd));
}
async function refreshBalances(ethPriceUsd) {
  const ws = getOrCreateWallets();
  const results = [];
  getGblinPriceUsd().catch(() => {
  });
  for (const w of ws) {
    try {
      const eth = await getEthBalance(w.address);
      await sleep(100);
      const tok = await getTokenBalance(w.address);
      if (eth < MIN_ETH_FOR_SELL) {
        logger.warn(
          { wallet: w.address, ethBalance: eth.toFixed(6), minForSell: MIN_ETH_FOR_SELL },
          "\u26A0\uFE0F  Wallet low on ETH \u2013 will be skipped for sells"
        );
      }
      const gblinPrice = state.gblinPriceUsd || 0;
      const tokenUsd = parseFloat((parseFloat(tok.human) * gblinPrice).toFixed(2));
      results.push({
        index: w.index,
        address: w.address,
        ethBalance: eth,
        usdBalance: parseFloat((eth * ethPriceUsd).toFixed(2)),
        tokenBalance: tok.human,
        tokenBalanceUsd: tokenUsd
      });
    } catch {
      const prev = state.wallets.find((x) => x.index === w.index);
      if (prev) results.push(prev);
      else results.push({ index: w.index, address: w.address, ethBalance: 0, usdBalance: 0, tokenBalance: "0", tokenBalanceUsd: 0 });
    }
    await sleep(150);
  }
  state.wallets = results;
}
var MAX_INTERVAL_MS = 75 * 6e4;
async function scheduleNextTrade() {
  if (!isRunning) return;
  let intervalMs = getIntervalMs();
  if (Math.random() < 0.08) {
    const restMultiplier = randomBetween(1.3, 1.7);
    intervalMs = Math.round(intervalMs * restMultiplier);
    logger.info({ restMultiplier: restMultiplier.toFixed(2) }, "Unplanned break \u2013 extending interval");
  }
  if (intervalMs > MAX_INTERVAL_MS) {
    logger.info({ cappedFrom: Math.round(intervalMs / 6e4) + " min", cappedTo: "75 min" }, "Interval capped at maximum");
    intervalMs = MAX_INTERVAL_MS;
  }
  const intervalSec = Math.round(intervalMs / 1e3);
  const nextAt = new Date(Date.now() + intervalMs).toISOString();
  state.nextTradeAt = nextAt;
  state.nextIntervalSec = intervalSec;
  const now = /* @__PURE__ */ new Date();
  const hour = now.getUTCHours();
  const zone = hour < 6 ? "night" : hour >= 14 && hour < 16 ? "peak-US" : "normal";
  logger.info(
    { nextIn: `${(intervalMs / 6e4).toFixed(1)} min`, nextAt, zone },
    "Next trade scheduled"
  );
  heartbeatTimeout = setTimeout(async () => {
    state.nextTradeAt = null;
    state.nextIntervalSec = null;
    if (!isRunning) return;
    try {
      const ethPrice = await getEthPriceUsd();
      state.ethPriceUsd = ethPrice;
      state.lastCheck = (/* @__PURE__ */ new Date()).toISOString();
      await distributeFunds(ethPrice);
      const record = await executeTrade(ethPrice);
      prevEthPriceUsd = ethPrice;
      state.lastTrade = record;
      state.totalTrades += 1;
      if (record.type === "buy") state.totalBuys += 1;
      if (record.type === "sell") state.totalSells += 1;
      state.recentTrades = [record, ...state.recentTrades].slice(0, 200);
      persistTrades();
      await refreshBalances(ethPrice);
    } catch (err) {
      logger.error({ err }, "Heartbeat cycle error \u2014 rescheduling anyway");
    } finally {
      scheduleNextTrade();
    }
  }, intervalMs);
}
function startWatchdog() {
  setInterval(() => {
    if (!isRunning) return;
    if (heartbeatTimeout !== null) return;
    if (state.nextTradeAt !== null) return;
    logger.warn("Watchdog: scheduler appears dead \u2014 restarting it");
    scheduleNextTrade();
  }, 5 * 6e4);
}
async function checkFunding() {
  try {
    const ethPrice = await getEthPriceUsd();
    state.ethPriceUsd = ethPrice;
    state.lastCheck = (/* @__PURE__ */ new Date()).toISOString();
    await refreshBalances(ethPrice);
    const totalUsd = state.wallets.reduce((s, w) => s + w.usdBalance, 0);
    logger.info({ totalUsd: totalUsd.toFixed(2), threshold: FUNDED_THRESHOLD_USD }, "Balance check");
    if (totalUsd >= FUNDED_THRESHOLD_USD) {
      logger.info("Wallets funded! Starting organic heartbeat...");
      state.status = "running";
      isRunning = true;
      if (!botStartedAt) botStartedAt = Date.now();
      if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }
      await distributeFunds(ethPrice);
      await refreshBalances(ethPrice);
      scheduleNextTrade();
    }
  } catch (err) {
    logger.error({ err }, "Error during funding check");
  }
}
async function startBot() {
  try {
    logger.info("Bot initializing \u2013 organic buy/sell mode (time-aware, weighted wallets)...");
    loadPersistedTrades();
    const ws = getOrCreateWallets();
    state.wallets = ws.map((w) => ({
      index: w.index,
      address: w.address,
      ethBalance: 0,
      usdBalance: 0,
      tokenBalance: "0",
      tokenBalanceUsd: 0
    }));
    getGblinPriceUsd().catch(() => {
    });
    state.status = "waiting_for_funds";
    logger.info(
      {
        wallets: ws.map((w) => ({ index: w.index, address: w.address })),
        network: "Base Mainnet",
        threshold: `$${FUNDED_THRESHOLD_USD}`,
        token: TOKEN_ADDRESS,
        uniPool: "0x8fdDa852a7b106b08848da676b8793814D561617",
        aeroPool: AERO_POOL,
        uniRouter: UNI_ROUTER,
        aeroRouter: AERO_ROUTER,
        buyPresets: BUY_PRESETS.map((p) => `$${p.amount}(${(p.weight * 100).toFixed(0)}%)`).join(" "),
        walletWeights: WALLET_WEIGHTS2.map((w, i) => `W${i}:${(w * 100).toFixed(0)}%`).join(" "),
        sellProbBase: (SELL_PROBABILITY_BASE * 100).toFixed(0) + "%",
        sellCooldown: SELL_COOLDOWN_MS / 6e4 + " min",
        intervalMode: "time-aware (night/peak/normal/weekend)"
      },
      "Bot ready \u2014 waiting for funds"
    );
    await checkFunding();
    if (state.status === "waiting_for_funds") {
      pollingTimer = setInterval(checkFunding, POLLING_INTERVAL_MS);
    }
    startWatchdog();
    logger.info("Watchdog started \u2014 scheduler will be auto-revived if it dies");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.status = "error";
    state.errorMessage = msg;
    logger.error({ err }, "Bot failed to initialize");
  }
}
function getBotState() {
  return { ...state };
}
function _recordTrade(record, type) {
  state.lastTrade = record;
  state.totalTrades += 1;
  if (type === "buy") state.totalBuys += 1;
  else state.totalSells += 1;
  state.recentTrades = [record, ...state.recentTrades].slice(0, 200);
  persistTrades();
  refreshBalances(state.ethPriceUsd).catch(() => {
  });
}
function triggerBuyNow() {
  if (!isRunning) return;
  logger.info("Manual BUY triggered (best execution)");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return bestExecutionBuy(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "buy")).catch((err) => logger.error({ err }, "Manual BUY failed"));
}
function triggerSellNow() {
  if (!isRunning) return;
  logger.info("Manual SELL triggered (best execution)");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return bestExecutionSell(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "sell")).catch((err) => logger.error({ err }, "Manual SELL failed"));
}
function triggerBuyUniswap() {
  if (!isRunning) return;
  logger.info("Manual BUY forced \u2192 Uniswap V3");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeBuy(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "buy")).catch((err) => logger.error({ err }, "Manual BUY Uniswap failed"));
}
function triggerBuyAerodrome() {
  if (!isRunning) return;
  logger.info("Manual BUY forced \u2192 Aerodrome V1");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeBuyAerodrome(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "buy")).catch((err) => logger.error({ err }, "Manual BUY Aerodrome failed"));
}
function triggerSellUniswap() {
  if (!isRunning) return;
  logger.info("Manual SELL forced \u2192 Uniswap V3");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeSell(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "sell")).catch((err) => logger.error({ err }, "Manual SELL Uniswap failed"));
}
function triggerSellAerodrome() {
  if (!isRunning) return;
  logger.info("Manual SELL forced \u2192 Aerodrome V1");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeSellAerodrome(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "sell")).catch((err) => logger.error({ err }, "Manual SELL Aerodrome failed"));
}
function triggerBuyGblinContract() {
  if (!isRunning) return;
  logger.info("Manual BUY forced \u2192 GBLIN contract");
  getEthPriceUsd().then(async (p) => {
    state.ethPriceUsd = p;
    const wallet = selectBestFundedWallet();
    const usdAmount = selectBuyAmountUsd();
    const ethAmount = usdAmount / p;
    const ethWei = parseEther2(ethAmount.toFixed(18));
    return executeBuyGblinContract(wallet, p, ethWei, usdAmount, true);
  }).then((r) => _recordTrade(r, "buy")).catch((err) => logger.error({ err }, "Manual BUY GBLIN contract failed"));
}
function triggerSellGblinContract() {
  if (!isRunning) return;
  logger.info("Manual SELL forced \u2192 GBLIN contract");
  getEthPriceUsd().then(async (p) => {
    state.ethPriceUsd = p;
    const ws = getOrCreateWallets();
    const balances = await Promise.all(ws.map((w) => getTokenBalance(w.address).then((b) => ({ w, raw: b.raw }))));
    const best = balances.reduce((a, b) => b.raw > a.raw ? b : a, balances[0]);
    const wallet = best.w;
    if (best.raw === 0n) throw new Error("No token balance in any wallet");
    const sellPct = randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
    const sellAmount = best.raw * BigInt(Math.floor(sellPct * 1e4)) / 10000n;
    logger.info({ wallet: wallet.address, tokens: formatUnits(best.raw, TOKEN_DECIMALS) }, "SELL GBLIN test \u2014 wallet selected by token balance");
    return executeSellGblinContract(wallet, p, sellAmount, true);
  }).then((r) => _recordTrade(r, "sell")).catch((err) => logger.error({ err }, "Manual SELL GBLIN contract failed"));
}
function getMetrics() {
  const trades = state.recentTrades;
  const uptimeSec = botStartedAt ? Math.round((Date.now() - botStartedAt) / 1e3) : 0;
  const uptimeHuman = uptimeSec < 60 ? `${uptimeSec}s` : uptimeSec < 3600 ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s` : `${Math.floor(uptimeSec / 3600)}h ${Math.floor(uptimeSec % 3600 / 60)}m`;
  const successful = trades.filter((t) => t.success).length;
  const successRate = trades.length > 0 ? (successful / trades.length * 100).toFixed(1) + "%" : "N/A";
  const buys = trades.filter((t) => t.type === "buy" && t.success);
  const sells = trades.filter((t) => t.type === "sell" && t.success);
  const avgBuyUsd = buys.length > 0 ? (buys.reduce((s, t) => s + t.usdAmount, 0) / buys.length).toFixed(4) : "N/A";
  const avgSellUsd = sells.length > 0 ? (sells.reduce((s, t) => s + t.usdAmount, 0) / sells.length).toFixed(4) : "N/A";
  const walletStats = Array.from({ length: 4 }, (_, i) => {
    const wb = trades.filter((t) => t.walletIndex === i);
    return {
      walletIndex: i,
      address: state.wallets.find((w) => w.index === i)?.address ?? "",
      totalTrades: wb.length,
      buys: wb.filter((t) => t.type === "buy").length,
      sells: wb.filter((t) => t.type === "sell").length,
      successfulTrades: wb.filter((t) => t.success).length,
      consecutiveBuys: consecutiveBuys.get(i) ?? 0,
      inSellCooldown: Date.now() - (lastSellTimestamp.get(i) ?? 0) < SELL_COOLDOWN_MS
    };
  });
  const totalVolumeBuyUsd = buys.reduce((s, t) => s + t.usdAmount, 0);
  const totalVolumeSellUsd = sells.reduce((s, t) => s + t.usdAmount, 0);
  return {
    uptime: uptimeHuman,
    uptimeSec,
    startedAt: botStartedAt ? new Date(botStartedAt).toISOString() : null,
    status: state.status,
    ethPriceUsd: state.ethPriceUsd,
    summary: {
      totalTrades: state.totalTrades,
      totalBuys: state.totalBuys,
      totalSells: state.totalSells,
      successRate,
      avgBuyUsd,
      avgSellUsd,
      totalVolumeBuyUsd: totalVolumeBuyUsd.toFixed(4),
      totalVolumeSellUsd: totalVolumeSellUsd.toFixed(4)
    },
    rebalance: {
      thresholdRange: "2\u20136 per wallet (random, re-rolled after each sell)",
      walletCounters: Array.from({ length: 4 }, (_, i) => ({
        walletIndex: i,
        consecutiveBuys: consecutiveBuys.get(i) ?? 0,
        currentThreshold: getRebalanceThreshold(i)
      }))
    },
    walletStats,
    nextTradeAt: state.nextTradeAt,
    nextIntervalSec: state.nextIntervalSec,
    lastTrade: state.lastTrade
  };
}

// src/routes/bot.ts
var router2 = Router2();
router2.get("/bot/status", (_req, res) => {
  const state2 = getBotState();
  res.json({
    status: state2.status,
    wallets: state2.wallets,
    market: {
      ethPriceUsd: state2.ethPriceUsd,
      gblinPriceUsd: state2.gblinPriceUsd,
      totalBalanceUsd: state2.wallets.reduce((s, w) => s + w.usdBalance + w.tokenBalanceUsd, 0).toFixed(2),
      totalEthUsd: state2.wallets.reduce((s, w) => s + w.usdBalance, 0).toFixed(2),
      totalGblinUsd: state2.wallets.reduce((s, w) => s + (w.tokenBalanceUsd || 0), 0).toFixed(2)
    },
    heartbeat: {
      targetToken: "0x38DcDB3A381677239BBc652aed9811F2f8496345",
      buyAmountRangeUsd: { min: 0.5, max: 1.5 },
      dexRouting: "best-execution: Uniswap V3 / Aerodrome V1 / GBLIN contract (quoted in parallel, cheapest wins)",
      sellAmountRange: "15\u201385% of token holdings",
      sellProbability: "40% base (25\u201355% dynamic)",
      intervalRangeMin: { night: "60\u2013180", peak: "20\u201345", normal: "35\u201390" },
      nextTradeAt: state2.nextTradeAt,
      nextIntervalSec: state2.nextIntervalSec,
      totalTrades: state2.totalTrades,
      totalBuys: state2.totalBuys,
      totalSells: state2.totalSells
    },
    lastCheck: state2.lastCheck,
    lastTrade: state2.lastTrade,
    recentTrades: state2.recentTrades,
    errorMessage: state2.errorMessage
  });
});
router2.get("/bot/metrics", (_req, res) => {
  res.json(getMetrics());
});
function guardRunning(res) {
  if (getBotState().status !== "running") {
    res.status(400).json({ error: "Bot non ancora avviato (wallet non finanziato)" });
    return false;
  }
  return true;
}
router2.post("/bot/buy-now", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY avviato (DEX casuale) \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerBuyNow();
});
router2.post("/bot/sell-now", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL avviato (DEX casuale) \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerSellNow();
});
router2.post("/bot/buy-uniswap", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY forzato su Uniswap V3 \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerBuyUniswap();
});
router2.post("/bot/buy-aerodrome", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY forzato su Aerodrome V1 \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerBuyAerodrome();
});
router2.post("/bot/sell-uniswap", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL forzato su Uniswap V3 \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerSellUniswap();
});
router2.post("/bot/sell-aerodrome", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL forzato su Aerodrome V1 \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerSellAerodrome();
});
router2.post("/bot/buy-gblin", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "BUY forzato su contratto GBLIN \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerBuyGblinContract();
});
router2.post("/bot/sell-gblin", (_req, res) => {
  if (!guardRunning(res)) return;
  res.json({ message: "SELL forzato su contratto GBLIN \u2014 controlla /api/bot/status tra qualche secondo" });
  triggerSellGblinContract();
});
var bot_default = router2;

// src/routes/index.ts
var router3 = Router3();
router3.use(health_default);
router3.use(bot_default);
var routes_default = router3;

// src/app.ts
var __dirname3 = dirname2(fileURLToPath3(import.meta.url));
var app = express();
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0]
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode
        };
      }
    }
  })
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", routes_default);
app.use(express.static(resolve3(__dirname3, "../public")));
var app_default = app;

// src/index.ts
var RUN_TOKEN = /* @__PURE__ */ Symbol.for("base-heartbeat-bot.running");
if (globalThis[RUN_TOKEN]) {
  logger.warn("Process already initialized \u2014 skipping duplicate start");
  process.exit(0);
}
globalThis[RUN_TOKEN] = true;
var rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided."
  );
}
var port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}
app_default.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  startBot().catch((err2) => {
    logger.error({ err: err2 }, "Bot startup error");
  });
  if (process.env["NODE_ENV"] === "production") {
    const selfUrl = `http://localhost:${port}/api/healthz`;
    setInterval(async () => {
      try {
        const res = await fetch(selfUrl);
        if (!res.ok) logger.warn({ status: res.status }, "Self-ping: unexpected status");
      } catch (e) {
        logger.warn({ err: e }, "Self-ping failed");
      }
    }, 2 * 60 * 1e3);
    logger.info("Self-ping enabled \u2014 bot stays alive on autoscale");
  }
});
