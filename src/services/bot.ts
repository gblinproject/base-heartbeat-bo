import {
  parseEther,
  formatUnits,
  encodeFunctionData,
} from "viem";
import {
  getOrCreateWallets,
  getEthBalance,
  getAllBalances,
  distributeFunds,
  publicClient,
} from "./wallet.js";
import { logger } from "../lib/logger.js";
import { sendTradeAlert } from "../lib/webhook.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

// ─── Constants ────────────────────────────────────────────────────────────────

// GBLIN V6 (contratto di produzione). V5 era 0x38DcDB3A381677239BBc652aed9811F2f8496345.
const TOKEN_ADDRESS = "0x36C81d7E1966310F305eA637e761Cf77F90852f0" as `0x${string}`;
const WETH_ADDRESS  = "0x4200000000000000000000000000000000000006" as `0x${string}`;

/** Uniswap V3 SwapRouter on Base — used for both BUY and SELL */
const UNI_ROUTER  = "0x2626664c2603336E57B271c5C0b26F421741e481" as `0x${string}`;

/** Uniswap V3 GBLIN(V6)/WETH pool on Base — fee 0.3%. (V5 era 0x8fdda852...561617, fee 300) */
const UNI_POOL     = "0xAb305c45F4E42A73909a49a6775e3f7782239dAE" as `0x${string}`;
const UNI_POOL_FEE = 3000; // 0.3% (tier scelto per la pool V6)

/** Aerodrome V1 volatile pool: GBLIN(V6)/WETH. (V5 era 0x7dcd4f5b...92ae1b) */
const AERO_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as `0x${string}`;
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as `0x${string}`;
const AERO_POOL    = "0x6Ac18D5e90278D2477027B5769EFb2fF0711FFbB" as `0x${string}`;


/** Base sell probability (adjusted dynamically by price momentum) */
const SELL_PROBABILITY_BASE = 0.40;

/**
 * Sell fraction range — intentionally wide to look human.
 */
const SELL_PCT_MIN = 0.15;
const SELL_PCT_MAX = 0.85;

/** Minimum ETH cushion kept in each wallet (for gas) */
const FUNDED_THRESHOLD_USD = 10;
const POLLING_INTERVAL_MS  = 60 * 1000;

/** Sell cooldown per wallet — avoids selling from the same wallet twice in a row */
const SELL_COOLDOWN_MS = 45 * 60 * 1000; // 45 min

/** GBLIN contract minimum buy: 0.0005 ETH (contract enforced) */
const GBLIN_MIN_ETH_WEI = parseEther("0.0005");

/** Max direct GBLIN-contract buys per calendar day (UTC). Remaining buys go to DEX pools. */
const GBLIN_CONTRACT_DAILY_BUY_LIMIT = 1;

// ─── Buy amount presets $0.50 – $1.50 (weighted toward human-friendly values) ──

const BUY_PRESETS: { amount: number; weight: number }[] = [
  { amount: 0.50, weight: 0.15 },
  { amount: 0.75, weight: 0.25 },
  { amount: 1.00, weight: 0.30 },
  { amount: 1.25, weight: 0.20 },
  { amount: 1.50, weight: 0.10 },
];

/** Per-wallet activity weights: W0 most active, W3 least active */
const WALLET_WEIGHTS = [0.35, 0.30, 0.20, 0.15];

/**
 * Minimum ETH a wallet must hold to participate in a sell.
 * A sell costs ~2 TXs (transfer + execute), so we need more gas headroom.
 * ~0.0005 ETH ≈ $1.50 at $3000 ETH — enough for both TXs on Base.
 */
const MIN_ETH_FOR_SELL = 0.0005;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

/** WETH9 ABI — deposit (wrap ETH), withdraw, approve */
const WETH9_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Uniswap V3 SwapRouter02 ABI — used for SELL */
const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn",           type: "address" },
          { name: "tokenOut",          type: "address" },
          { name: "fee",               type: "uint24"  },
          { name: "recipient",         type: "address" },
          { name: "amountIn",          type: "uint256" },
          { name: "amountOutMinimum",  type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data",     type: "bytes[]" },
    ],
    outputs: [{ name: "", type: "bytes[]" }],
  },
  {
    name: "unwrapWETH9",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient",     type: "address" },
    ],
    outputs: [],
  },
] as const;

/** Aerodrome V1 Router ABI — swapExactETHForTokens + swapExactTokensForETH */
const AERO_ROUTER_ABI = [
  {
    name: "swapExactETHForTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes", type: "tuple[]",
        components: [
          { name: "from",    type: "address" },
          { name: "to",      type: "address" },
          { name: "stable",  type: "bool"    },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactTokensForETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn",     type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes", type: "tuple[]",
        components: [
          { name: "from",    type: "address" },
          { name: "to",      type: "address" },
          { name: "stable",  type: "bool"    },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

/** Uniswap V3 pool slot0 — free on-chain price read (no QuoterV2 needed) */
const UNI_POOL_SLOT0_ABI = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96",             type: "uint160" },
      { name: "tick",                     type: "int24"   },
      { name: "observationIndex",         type: "uint16"  },
      { name: "observationCardinality",   type: "uint16"  },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol",              type: "uint8"   },
      { name: "unlocked",                 type: "bool"    },
    ],
  },
] as const;

/** Aerodrome Router — getAmountsOut for quoting (read-only) */
const AERO_AMOUNTS_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes", type: "tuple[]",
        components: [
          { name: "from",    type: "address" },
          { name: "to",      type: "address" },
          { name: "stable",  type: "bool"    },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

/** GBLIN contract — buy/sell/quote functions */
const GBLIN_CONTRACT_ABI = [
  {
    name: "buyGBLIN",
    type: "function",
    stateMutability: "payable",
    inputs:  [{ name: "minGblinOut", type: "uint256" }],
    outputs: [],
  },
  {
    name: "sellGBLINForEth",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gblinAmount", type: "uint256" },
      { name: "minEthOut",   type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "quoteBuyGBLIN",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "ethAmount", type: "uint256" }],
    outputs: [
      { name: "gblinOut",      type: "uint256" },
      { name: "wethToReserve", type: "uint256" },
      { name: "fee",           type: "uint256" },
    ],
  },
  {
    name: "quoteSellGBLIN",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "gblinAmount", type: "uint256" }],
    outputs: [{ name: "ethOut", type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BotStatus = "initializing" | "waiting_for_funds" | "running" | "error";
export type TradeType = "buy" | "sell";

export interface TradeRecord {
  timestamp:     string;
  type:          TradeType;
  walletIndex:   number;
  walletAddress: string;
  ethAmount:     number;
  usdAmount:     number;
  tokenAmount?:  string;
  ethPriceUsd:   number;
  txHash:        string | null;
  success:       boolean;
  error?:        string;
  dex?:          string;
}

interface WalletInfo {
  index:           number;
  address:         string;
  ethBalance:      number;
  usdBalance:      number;   // ETH value in USD
  tokenBalance:    string;   // GBLIN (human-readable)
  tokenBalanceUsd: number;   // GBLIN value in USD
}

interface BotState {
  status:          BotStatus;
  wallets:         WalletInfo[];
  ethPriceUsd:     number;
  gblinPriceUsd:   number;
  lastCheck:       string | null;
  lastTrade:       TradeRecord | null;
  nextTradeAt:     string | null;
  nextIntervalSec: number | null;
  totalTrades:     number;
  totalBuys:       number;
  totalSells:      number;
  recentTrades:    TradeRecord[];
  errorMessage:    string | null;
}

// ─── State ────────────────────────────────────────────────────────────────────

const state: BotState = {
  status:          "initializing",
  wallets:         [],
  ethPriceUsd:     0,
  gblinPriceUsd:   0,
  lastCheck:       null,
  lastTrade:       null,
  nextTradeAt:     null,
  nextIntervalSec: null,
  totalTrades:     0,
  totalBuys:       0,
  totalSells:      0,
  recentTrades:    [],
  errorMessage:    null,
};

let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
let pollingTimer:     ReturnType<typeof setInterval>  | null = null;
let isRunning = false;

/** ETH price from the previous cycle – used to detect momentum */
let prevEthPriceUsd = 0;

/** Timestamp when startBot() first set status → running */
let botStartedAt: number | null = null;

/** Last sell timestamp per wallet index – enforces cooldown */
const lastSellTimestamp    = new Map<number, number>();
/** Timestamp of last successful GBLIN-contract BUY per wallet (2-min sell lock) */
const lastGblinBuyTimestamp = new Map<number, number>();
const GBLIN_SELL_LOCK_MS    = 150_000; // 2.5 min (30s margin over contract's 2-min lock)

// ─── Daily GBLIN-contract buy counter ─────────────────────────────────────────
let gblinContractBuyCountToday = 0;
let gblinContractBuyDayKey     = ""; // "YYYY-MM-DD" UTC
let gblinContractBuyUnlockMs   = 0;  // random UTC timestamp within today when GBLIN is unlocked

// ─── Daily forced-buy slots (Uniswap + Aerodrome must each execute ≥1 buy/day) ─
let forcedBuyDayKey             = "";
let uniswapForcedBuyDoneToday   = false;
let aerodromeForcedBuyDoneToday = false;
let uniswapForcedBuyTimeMs      = 0;   // random UTC time when Uniswap forced-buy triggers
let aerodromeForcedBuyTimeMs    = 0;   // random UTC time when Aerodrome forced-buy triggers

/**
 * Resets the per-venue forced-buy state at UTC midnight and picks a random
 * trigger time within the new day for each venue.
 */
function refreshForcedBuySlots(): void {
  const today = getUtcDateKey();
  if (forcedBuyDayKey !== today) {
    forcedBuyDayKey             = today;
    uniswapForcedBuyDoneToday   = false;
    aerodromeForcedBuyDoneToday = false;
    const midnight = new Date(today + "T00:00:00Z").getTime();
    const dayMs    = 24 * 60 * 60 * 1000;
    uniswapForcedBuyTimeMs   = midnight + Math.floor(Math.random() * dayMs);
    aerodromeForcedBuyTimeMs = midnight + Math.floor(Math.random() * dayMs);
    logger.info(
      {
        date:              today,
        uniswapForcedAt:   new Date(uniswapForcedBuyTimeMs).toISOString().slice(11, 16)   + " UTC",
        aerodromeForcedAt: new Date(aerodromeForcedBuyTimeMs).toISOString().slice(11, 16) + " UTC",
      },
      "Daily forced-buy slots randomized (Uniswap V3 + Aerodrome V1)"
    );
  }
}

/**
 * Returns which venue (if any) must be forced on the next buy because its
 * daily minimum has not been satisfied yet and the trigger time has passed.
 * Uniswap takes priority if both are due simultaneously.
 */
function getForcedBuyVenue(): "uniswap" | "aerodrome" | null {
  refreshForcedBuySlots();
  const now = Date.now();
  if (!uniswapForcedBuyDoneToday   && now >= uniswapForcedBuyTimeMs)   return "uniswap";
  if (!aerodromeForcedBuyDoneToday && now >= aerodromeForcedBuyTimeMs) return "aerodrome";
  return null;
}

/** Mark a venue's forced-buy as satisfied for today (call after a confirmed buy). */
function recordVenueBuyUsed(venue: string): void {
  if (venue === "uniswap")   uniswapForcedBuyDoneToday   = true;
  if (venue === "aerodrome") aerodromeForcedBuyDoneToday = true;
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resets the daily GBLIN counter and picks a random unlock time within the new day.
 * The unlock time is a random UTC timestamp between 00:00 and 23:59 of that day,
 * so the one allowed GBLIN-contract buy happens at an unpredictable moment.
 */
function refreshGblinDailySlot(): void {
  const today = getUtcDateKey();
  if (gblinContractBuyDayKey !== today) {
    gblinContractBuyCountToday = 0;
    gblinContractBuyDayKey     = today;
    const midnightMs  = new Date(today + "T00:00:00Z").getTime();
    const randomOffMs = Math.floor(Math.random() * 24 * 60 * 60 * 1000);
    gblinContractBuyUnlockMs  = midnightMs + randomOffMs;
    logger.info(
      { date: today, gblinUnlockAt: new Date(gblinContractBuyUnlockMs).toISOString().slice(11, 16) + " UTC" },
      "Daily GBLIN contract buy slot randomized"
    );
  }
}

/** Returns true if the bot is allowed to buy directly from the GBLIN contract right now. */
function isGblinContractBuyAllowed(): boolean {
  refreshGblinDailySlot();
  return gblinContractBuyCountToday < GBLIN_CONTRACT_DAILY_BUY_LIMIT &&
         Date.now() >= gblinContractBuyUnlockMs;
}

/** Call after a confirmed GBLIN-contract buy to consume today's quota. */
function recordGblinContractBuyUsed(): void {
  refreshGblinDailySlot();
  gblinContractBuyCountToday++;
}

/**
 * Consecutive buy count per wallet.
 * Each wallet gets its own random threshold (2–6) that is re-rolled after every sell.
 * This breaks the predictable buy-buy-sell pattern.
 */
const consecutiveBuys          = new Map<number, number>();
const walletRebalanceThreshold  = new Map<number, number>();

function rollRebalanceThreshold(walletIndex: number): number {
  // Pick a random threshold between 2 and 6 (inclusive)
  const t = Math.floor(randomBetween(2, 7));
  walletRebalanceThreshold.set(walletIndex, t);
  return t;
}

function getRebalanceThreshold(walletIndex: number): number {
  if (!walletRebalanceThreshold.has(walletIndex)) rollRebalanceThreshold(walletIndex);
  return walletRebalanceThreshold.get(walletIndex)!;
}

// ─── Trade log persistence ────────────────────────────────────────────────────

const __dirname  = fileURLToPath(new URL(".", import.meta.url));
const TRADES_LOG = resolve(__dirname, "../../trades.json");

interface TradesFile {
  totalTrades: number;
  totalBuys:   number;
  totalSells:  number;
  trades:      TradeRecord[];
}

function loadPersistedTrades(): void {
  try {
    if (!existsSync(TRADES_LOG)) return;
    const raw  = readFileSync(TRADES_LOG, "utf-8");
    const data = JSON.parse(raw) as TradesFile;
    state.totalTrades  = data.totalTrades  ?? 0;
    state.totalBuys    = data.totalBuys    ?? 0;
    state.totalSells   = data.totalSells   ?? 0;
    state.recentTrades = (data.trades ?? []).slice(0, 200);
    state.lastTrade    = state.recentTrades[0] ?? null;
    logger.info({ totalTrades: state.totalTrades }, "Trade history loaded from disk");
  } catch (err) {
    logger.warn({ err }, "Could not load trade history – starting fresh");
  }
}

function persistTrades(): void {
  try {
    const data: TradesFile = {
      totalTrades: state.totalTrades,
      totalBuys:   state.totalBuys,
      totalSells:  state.totalSells,
      trades:      state.recentTrades.slice(0, 200),
    };
    writeFileSync(TRADES_LOG, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.warn({ err }, "Could not persist trades to disk");
  }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Time-aware interval ──────────────────────────────────────────────────────

/**
 * Returns a random wait interval in ms that reflects realistic human trading.
 *   - Night (00:00–05:59 UTC) → slow (45–120 min)
 *   - Peak EU+US hours (12:00–21:59 UTC) → active (8–22 min)
 *   - Normal hours → 18–45 min
 *   - Weekend (Sat/Sun) → 1.3× slower than normal
 */
function getIntervalMs(): number {
  const now  = new Date();
  const hour = now.getUTCHours();
  const day  = now.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = day === 0 || day === 6;
  const isNight   = hour < 6;
  const isPeak    = hour >= 12 && hour < 22;

  let minMs: number;
  let maxMs: number;

  if (isNight) {
    minMs =  45 * 60_000;
    maxMs = 120 * 60_000;
  } else if (isPeak) {
    minMs =  8 * 60_000;
    maxMs = 22 * 60_000;
  } else {
    minMs = 18 * 60_000;
    maxMs = 45 * 60_000;
  }

  if (isWeekend) {
    minMs = Math.round(minMs * 1.3);
    maxMs = Math.round(maxMs * 1.3);
  }

  return randomBetween(minMs, maxMs);
}

// ─── Price-aware sell probability ─────────────────────────────────────────────

/**
 * Adjusts sell probability based on ETH price momentum:
 *   +1.5 % or more  → sell more eagerly (55 %)
 *   −1.5 % or less  → hold / buy (25 %)
 *   flat            → baseline 40 %
 */
function currentSellProbability(ethPriceUsd: number): number {
  if (prevEthPriceUsd === 0) return SELL_PROBABILITY_BASE;
  const pct = (ethPriceUsd - prevEthPriceUsd) / prevEthPriceUsd;
  if (pct >  0.015) return 0.55;
  if (pct < -0.015) return 0.25;
  return SELL_PROBABILITY_BASE;
}

// NAV-aware direction: the GBLIN contract redeems/mints at NAV (treasury value),
// while the pools have their own market price. Trading toward the peg is the
// profitable direction (buy below NAV, sell above NAV) and keeps the pools pegged.
// A dead-band (~1%) absorbs fees so we don't churn pointlessly inside fair value.
async function navAwareSellProbability(ethPriceUsd: number): Promise<number> {
  try {
    const ONE_GBLIN = 10n ** 18n;
    const [navWei, uniWei, aeroWei] = await Promise.all([
      quoteGblinContractSell(ONE_GBLIN).catch(() => 0n),
      quoteUniSell(ONE_GBLIN).catch(() => 0n),
      quoteAerodromeSell(ONE_GBLIN).catch(() => 0n),
    ]);
    const poolWei = uniWei > aeroWei ? uniWei : aeroWei; // best ETH a pool seller would get
    if (navWei <= 0n || poolWei <= 0n) return currentSellProbability(ethPriceUsd);
    const dev = (Number(poolWei) - Number(navWei)) / Number(navWei);
    const BAND = 0.01; // 1% dead-band covering swap fees
    if (dev > BAND) {
      const p = Math.min(0.9, 0.55 + dev * 4);
      logger.info({ pegDeviationPct: (dev * 100).toFixed(2) + "%", sellBias: (p * 100).toFixed(0) + "%" }, "NAV-aware: pool ABOVE NAV -> bias SELL (sell high, restore peg)");
      return p;
    }
    if (dev < -BAND) {
      const p = Math.max(0.1, 0.25 + dev * 2);
      logger.info({ pegDeviationPct: (dev * 100).toFixed(2) + "%", buyBias: ((1 - p) * 100).toFixed(0) + "%" }, "NAV-aware: pool BELOW NAV -> bias BUY (buy low, restore peg)");
      return p;
    }
    return SELL_PROBABILITY_BASE;
  } catch {
    return currentSellProbability(ethPriceUsd);
  }
}

// ─── Wallet selection (weighted) ──────────────────────────────────────────────

/**
 * Selects a wallet index according to WALLET_WEIGHTS so that W0 trades most
 * and W3 trades least, mimicking different user activity levels.
 */
function selectWalletIndex(): number {
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < WALLET_WEIGHTS.length; i++) {
    cumulative += WALLET_WEIGHTS[i]!;
    if (r < cumulative) return i;
  }
  return WALLET_WEIGHTS.length - 1;
}

/** For manual test triggers: always pick the wallet with the highest ETH balance. */
function selectBestFundedWallet() {
  const ws = getOrCreateWallets();
  // Real ETH balances live in state.wallets — the wallet objects from
  // getOrCreateWallets() have no ethBalance field (old reduce always picked W0).
  let bestIndex = ws[0]!.index;
  let bestBal = -1;
  for (const sw of state.wallets) {
    if (typeof sw.ethBalance === "number" && sw.ethBalance > bestBal) {
      bestBal = sw.ethBalance;
      bestIndex = sw.index;
    }
  }
  return ws.find((w) => w.index === bestIndex) ?? ws[0]!;
}

// ─── Buy amount selection (weighted presets) ───────────────────────────────────

/**
 * Picks a buy amount in USD from a weighted list of "round" human-friendly
 * values, then adds a small random noise (±0–0.004 USD) so the on-chain
 * amounts are never identical multiples — looks less mechanical.
 */
function selectBuyAmountUsd(): number {
  const r = Math.random();
  let cumulative = 0;
  let base = BUY_PRESETS[BUY_PRESETS.length - 1]!.amount;
  for (const preset of BUY_PRESETS) {
    cumulative += preset.weight;
    if (r < cumulative) { base = preset.amount; break; }
  }
  // Add ±0–0.06 USD noise to avoid mechanical identical amounts, clamp to [0.45, 1.55]
  const noise = (Math.random() - 0.5) * 0.12;
  return Math.max(0.45, Math.min(1.55, base + noise));
}

// ─── Pre-trade jitter ─────────────────────────────────────────────────────────

/**
 * Waits a random 0–180 second delay before executing a trade.
 * Uses a bimodal distribution: usually short (0–30s) but occasionally
 * long (60–180s) — simulates a human who sometimes hesitates.
 * Skipped for manual triggers so the user gets immediate feedback.
 */
async function applyJitter(manual = false): Promise<void> {
  if (manual) return;
  // 70% quick decision (0–30s), 30% slow / hesitant (60–180s)
  const ms = Math.random() < 0.70
    ? randomBetween(0, 30_000)
    : randomBetween(60_000, 180_000);
  logger.info({ jitterSec: (ms / 1000).toFixed(1) }, "Jitter delay before trade");
  await sleep(ms);
}

// ─── Gas price with slight random variation ───────────────────────────────────

/**
 * Returns a gas price (in wei) with ±15 % variation around Base's base fee.
 * Simulates wallets that use different gas settings.
 */
async function getVariedGasPrice(): Promise<bigint> {
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 1_000_000n; // ~0.001 gwei on Base
    // Add a priority tip between 0.5× and 1.5× the base fee
    const tipMultiplier = randomBetween(0.5, 1.5);
    const tip = BigInt(Math.round(Number(baseFee) * tipMultiplier));
    return baseFee + tip;
  } catch {
    return 1_500_000n; // fallback ~1.5 gwei
  }
}

// ─── ETH price ────────────────────────────────────────────────────────────────

async function getEthPriceUsd(): Promise<number> {
  // 1st try: Coinbase public spot price (no key, no rate limit)
  try {
    const res  = await fetch(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = (await res.json()) as { data?: { amount?: string } };
    const price = parseFloat(data?.data?.amount ?? "0");
    if (price > 100) return price;
  } catch { /* fall through */ }

  // 2nd try: Binance ticker (no key)
  try {
    const res  = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = (await res.json()) as { price?: string };
    const price = parseFloat(data?.price ?? "0");
    if (price > 100) return price;
  } catch { /* fall through */ }

  // 3rd try: CoinGecko
  try {
    const res  = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(10_000) }
    );
    const data = (await res.json()) as { ethereum?: { usd?: number } };
    const price = data?.ethereum?.usd ?? 0;
    if (price > 100) return price;
  } catch { /* fall through */ }

  return state.ethPriceUsd || 2500;
}

/** Fetches GBLIN price in USD from DexScreener (best-liquidity pair). Falls back to cached value. */
async function getGblinPriceUsd(): Promise<number> {
  try {
    const res  = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = (await res.json()) as { pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] };
    const pairs = (data?.pairs ?? [])
      .filter((p) => p.priceUsd && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : 0;
    if (price > 0) state.gblinPriceUsd = price;
    return price || state.gblinPriceUsd || 0;
  } catch {
    return state.gblinPriceUsd || 0;
  }
}

/** TOKEN uses 18 decimals (verified on-chain) */
const TOKEN_DECIMALS = 18;

async function getTokenBalance(address: `0x${string}`): Promise<{ raw: bigint; human: string }> {
  const raw = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi:     ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return { raw, human: formatUnits(raw, TOKEN_DECIMALS) };
}


// ─── Best-execution quoting (all eth_call — zero gas cost) ───────────────────

interface QuoteResult {
  venue: "uniswap" | "aerodrome" | "gblin";
  label: string;
  amountOut: bigint;
}

/**
 * Quote Uniswap V3: ETH → TOKEN (buy).
 * Uses pool slot0 sqrtPriceX96 directly — no QuoterV2 needed.
 * token0=GBLIN, token1=WETH → price = sqrtPriceX96² / 2¹⁹² = WETH per GBLIN
 * amountOut_GBLIN = amountIn_WETH × 2¹⁹² / sqrtPriceX96² × (1e6 − fee) / 1e6
 */
async function quoteUniBuy(ethWei: bigint): Promise<bigint> {
  const slot0 = await publicClient.readContract({
    address: UNI_POOL,
    abi:     UNI_POOL_SLOT0_ABI,
    functionName: "slot0",
  });
  const sqrtPriceX96 = slot0[0];
  const Q192 = 2n ** 192n;
  return (ethWei * Q192 / (sqrtPriceX96 * sqrtPriceX96)) *
    (1_000_000n - BigInt(UNI_POOL_FEE)) / 1_000_000n;
}

/**
 * Quote Uniswap V3: TOKEN → ETH (sell).
 * amountOut_WETH = amountIn_GBLIN × sqrtPriceX96² / 2¹⁹² × (1e6 − fee) / 1e6
 */
async function quoteUniSell(gblinWei: bigint): Promise<bigint> {
  const slot0 = await publicClient.readContract({
    address: UNI_POOL,
    abi:     UNI_POOL_SLOT0_ABI,
    functionName: "slot0",
  });
  const sqrtPriceX96 = slot0[0];
  const Q192 = 2n ** 192n;
  return (gblinWei * (sqrtPriceX96 * sqrtPriceX96) / Q192) *
    (1_000_000n - BigInt(UNI_POOL_FEE)) / 1_000_000n;
}

const AERO_ROUTE_BUY  = [{ from: WETH_ADDRESS,  to: TOKEN_ADDRESS, stable: false, factory: AERO_FACTORY }] as const;
const AERO_ROUTE_SELL = [{ from: TOKEN_ADDRESS, to: WETH_ADDRESS,  stable: false, factory: AERO_FACTORY }] as const;

/** Quote Aerodrome V1: ETH → TOKEN (buy) */
async function quoteAerodromeBuy(ethWei: bigint): Promise<bigint> {
  const amounts = await publicClient.readContract({
    address: AERO_ROUTER,
    abi:     AERO_AMOUNTS_ABI,
    functionName: "getAmountsOut",
    args:    [ethWei, AERO_ROUTE_BUY],
  });
  return amounts[amounts.length - 1]!;
}

/** Quote Aerodrome V1: TOKEN → ETH (sell) */
async function quoteAerodromeSell(gblinWei: bigint): Promise<bigint> {
  const amounts = await publicClient.readContract({
    address: AERO_ROUTER,
    abi:     AERO_AMOUNTS_ABI,
    functionName: "getAmountsOut",
    args:    [gblinWei, AERO_ROUTE_SELL],
  });
  return amounts[amounts.length - 1]!;
}

/** Quote GBLIN contract: ETH → TOKEN (buy) */
async function quoteGblinContractBuy(ethWei: bigint): Promise<bigint> {
  // Enforce contract minimum: 0.0005 ETH
  const safeEthWei = ethWei < GBLIN_MIN_ETH_WEI ? GBLIN_MIN_ETH_WEI : ethWei;
  const [gblinOut] = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi:     GBLIN_CONTRACT_ABI,
    functionName: "quoteBuyGBLIN",
    args:    [safeEthWei],
  });
  // Apply 0.1% fee discount for fair comparison: the contract retains 0.1% of
  // the buy amount regardless of whether quoteBuyGBLIN returns gross or net.
  // This ensures GBLIN only wins best-execution if genuinely cheaper post-fee.
  return (gblinOut * 999n) / 1000n;
}

/** Quote GBLIN contract: TOKEN → ETH (sell) */
async function quoteGblinContractSell(gblinWei: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi:     GBLIN_CONTRACT_ABI,
    functionName: "quoteSellGBLIN",
    args:    [gblinWei],
  });
}

/**
 * Queries Uniswap V3, Aerodrome V1 and GBLIN contract in parallel and returns
 * the venue offering the most output tokens (for buy). Never costs gas.
 */
async function findBestBuyVenue(ethWei: bigint, excludeGblin = false): Promise<QuoteResult> {
  if (excludeGblin) {
    logger.info(
      { gblinCountToday: gblinContractBuyCountToday, limit: GBLIN_CONTRACT_DAILY_BUY_LIMIT },
      "GBLIN contract daily limit reached – quoting Uniswap V3 + Aerodrome only"
    );
  }

  const [uni, aero, gblin] = await Promise.allSettled([
    quoteUniBuy(ethWei).then((a): QuoteResult => ({ venue: "uniswap", label: "Uniswap V3",     amountOut: a })),
    quoteAerodromeBuy(ethWei).then((a): QuoteResult => ({ venue: "aerodrome", label: "Aerodrome V1", amountOut: a })),
    ...(excludeGblin ? [] : [quoteGblinContractBuy(ethWei).then((a): QuoteResult => ({ venue: "gblin", label: "GBLIN contract", amountOut: a }))]),
  ]);

  const results: QuoteResult[] = [];
  if (uni.status   === "fulfilled") results.push(uni.value);
  if (aero.status  === "fulfilled") results.push(aero.value);
  if (!excludeGblin && gblin?.status === "fulfilled") results.push((gblin as PromiseFulfilledResult<QuoteResult>).value);

  if (results.length === 0) throw new Error("All buy venues failed to quote");

  results.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  logger.info(
    { quotes: results.map(r => `${r.label}: ${formatUnits(r.amountOut, TOKEN_DECIMALS)} GBLIN`), winner: results[0]!.label },
    "Best execution BUY quote"
  );
  return results[0]!;
}

async function findBestSellVenue(gblinWei: bigint, walletIndex?: number): Promise<QuoteResult> {
  // GBLIN contract enforces a 2-minute lock between buy and sell on the same wallet
  const gblinLocked = walletIndex !== undefined &&
    (Date.now() - (lastGblinBuyTimestamp.get(walletIndex) ?? 0)) < GBLIN_SELL_LOCK_MS;

  if (gblinLocked) {
    const secsLeft = Math.ceil((GBLIN_SELL_LOCK_MS - (Date.now() - (lastGblinBuyTimestamp.get(walletIndex!) ?? 0))) / 1000);
    logger.info({ walletIndex, secsLeft }, "GBLIN sell lock active – excluding GBLIN from sell venues");
  }

  const [uni, aero, gblin] = await Promise.allSettled([
    quoteUniSell(gblinWei).then((a): QuoteResult => ({ venue: "uniswap", label: "Uniswap V3",     amountOut: a })),
    quoteAerodromeSell(gblinWei).then((a): QuoteResult => ({ venue: "aerodrome", label: "Aerodrome V1", amountOut: a })),
    ...(gblinLocked ? [] : [quoteGblinContractSell(gblinWei).then((a): QuoteResult => ({ venue: "gblin", label: "GBLIN contract", amountOut: a }))]),
  ]);

  const results: QuoteResult[] = [];
  if (uni.status   === "fulfilled") results.push(uni.value);
  if (aero.status  === "fulfilled") results.push(aero.value);
  if (!gblinLocked && gblin?.status === "fulfilled") results.push((gblin as PromiseFulfilledResult<QuoteResult>).value);

  if (results.length === 0) throw new Error("All sell venues failed to quote");

  results.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  logger.info(
    { quotes: results.map(r => `${r.label}: ${formatUnits(r.amountOut, 18)} ETH`), winner: results[0]!.label },
    "Best execution SELL quote"
  );
  return results[0]!;
}

// ─── Path / calldata helpers ──────────────────────────────────────────────────

/** Encode exactInputSingle calldata for SwapRouter02 (sell leg) */
function encodeExactInputSingle(params: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn:           params.tokenIn,
      tokenOut:          params.tokenOut,
      fee:               params.fee,
      recipient:         params.recipient,
      amountIn:          params.amountIn,
      amountOutMinimum:  params.amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });
}

/** Encode unwrapWETH9 calldata for SwapRouter02 */
function encodeUnwrapWETH9(recipient: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "unwrapWETH9",
    args: [0n, recipient],
  });
}

// ─── Buy ──────────────────────────────────────────────────────────────────────

async function executeBuy(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  manual = false,
  ethWeiIn?: bigint,
  usdAmountIn?: number,
): Promise<TradeRecord> {
  const precomputed = ethWeiIn !== undefined && usdAmountIn !== undefined;
  if (!precomputed) await applyJitter(manual);
  const usdAmount = precomputed ? usdAmountIn! : selectBuyAmountUsd();
  const ethWei    = precomputed ? ethWeiIn!    : parseEther((usdAmount / ethPriceUsd).toFixed(18));
  const ethAmount = Number(ethWei) / 1e18;
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 300);

  const record: TradeRecord = {
    timestamp:    new Date().toISOString(),
    type:         "buy",
    walletIndex:  wallet.index,
    walletAddress: wallet.address,
    ethAmount,
    usdAmount,
    ethPriceUsd,
    txHash:  null,
    success: false,
    dex:     "Uniswap V3",
  };

  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < ethAmount + 0.0001) {
    record.error = `Low ETH balance: ${ethBalance.toFixed(6)} ETH`;
    logger.warn({ wallet: wallet.address, balance: ethBalance }, "Skipping buy – low ETH");
    return record;
  }

  logger.info(
    { wallet: wallet.address, usd: usdAmount.toFixed(4), eth: ethAmount.toFixed(8) },
    "Executing BUY..."
  );

  try {
    // Single transaction: send ETH as msg.value — SwapRouter wraps it internally
    logger.info({ wallet: wallet.address, usd: usdAmount.toFixed(4) }, "Sending ETH → TOKEN swap (1 tx)...");
    const gasPrice = await getVariedGasPrice();
    const hash = await wallet.walletClient.writeContract({
      address: UNI_ROUTER,
      abi:     SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn:           WETH_ADDRESS,
        tokenOut:          TOKEN_ADDRESS,
        fee:               UNI_POOL_FEE,
        recipient:         wallet.address,
        amountIn:          ethWei,
        amountOutMinimum:  0n,
        sqrtPriceLimitX96: 0n,
      }],
      value:    ethWei,
      gasPrice,
    });
    const tokBefore = await getTokenBalance(wallet.address);
    await publicClient.waitForTransactionReceipt({ hash });
    const tokAfter  = await getTokenBalance(wallet.address);
    record.txHash      = hash;
    record.tokenAmount = formatUnits(
      tokAfter.raw > tokBefore.raw ? tokAfter.raw - tokBefore.raw : 0n,
      TOKEN_DECIMALS
    );
    record.success = true;
    // Increment rebalance counter for this wallet
    consecutiveBuys.set(wallet.index, (consecutiveBuys.get(wallet.index) ?? 0) + 1);
    logger.info(
      { hash, usd: usdAmount.toFixed(4), gblinReceived: record.tokenAmount, consecutiveBuys: consecutiveBuys.get(wallet.index) },
      "BUY confirmed ✅"
    );
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "BUY failed");
  }

  sendTradeAlert(record).catch(() => {}); // fire-and-forget
  return record;
}

// ─── Aerodrome V1 Buy ─────────────────────────────────────────────────────────

async function executeBuyAerodrome(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  manual = false,
  ethWeiIn?: bigint,
  usdAmountIn?: number,
): Promise<TradeRecord> {
  const precomputed = ethWeiIn !== undefined && usdAmountIn !== undefined;
  if (!precomputed) await applyJitter(manual);
  const usdAmount = precomputed ? usdAmountIn! : selectBuyAmountUsd();
  const ethWei    = precomputed ? ethWeiIn!    : parseEther((usdAmount / ethPriceUsd).toFixed(18));
  const ethAmount = Number(ethWei) / 1e18;
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 300);

  const record: TradeRecord = {
    timestamp:     new Date().toISOString(),
    type:          "buy",
    walletIndex:   wallet.index,
    walletAddress: wallet.address,
    ethAmount,
    usdAmount,
    tokenAmount:   "0",
    ethPriceUsd,
    txHash:        null,
    success:       false,
    dex:           "Aerodrome",
  };

  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < ethAmount + 0.0001) {
    record.error = `Low ETH balance: ${ethBalance.toFixed(6)} ETH`;
    return record;
  }

  logger.info({ wallet: wallet.address, usd: usdAmount.toFixed(4), dex: "Aerodrome" }, "Executing BUY (Aerodrome)...");

  try {
    const gasPrice = await getVariedGasPrice();
    const hash = await wallet.walletClient.writeContract({
      address:      AERO_ROUTER,
      abi:          AERO_ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [
        0n,
        [{ from: WETH_ADDRESS, to: TOKEN_ADDRESS, stable: false, factory: AERO_FACTORY }],
        wallet.address,
        deadline,
      ],
      value:    ethWei,
      gasPrice,
    });
    const tokBefore = await getTokenBalance(wallet.address);
    await publicClient.waitForTransactionReceipt({ hash });
    const tokAfter  = await getTokenBalance(wallet.address);
    record.txHash      = hash;
    record.tokenAmount = formatUnits(
      tokAfter.raw > tokBefore.raw ? tokAfter.raw - tokBefore.raw : 0n,
      TOKEN_DECIMALS
    );
    record.success = true;
    consecutiveBuys.set(wallet.index, (consecutiveBuys.get(wallet.index) ?? 0) + 1);
    logger.info({ hash, usd: usdAmount.toFixed(4), gblinReceived: record.tokenAmount, dex: "Aerodrome" }, "BUY Aerodrome confirmed ✅");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "BUY Aerodrome failed");
  }

  sendTradeAlert(record).catch(() => {});
  return record;
}

// ─── Aerodrome V1 Sell ────────────────────────────────────────────────────────

async function executeSellAerodrome(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  manual = false,
  sellAmountIn?: bigint,
): Promise<TradeRecord> {
  const precomputed = sellAmountIn !== undefined;
  if (!precomputed) await applyJitter(manual);
  const { raw: tokenBalanceRaw, human: tokenBalanceHuman } = await getTokenBalance(wallet.address);

  const record: TradeRecord = {
    timestamp:     new Date().toISOString(),
    type:          "sell",
    walletIndex:   wallet.index,
    walletAddress: wallet.address,
    ethAmount:     0,
    usdAmount:     0,
    tokenAmount:   "0",
    ethPriceUsd,
    txHash:        null,
    success:       false,
    dex:           "Aerodrome",
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

  const sellPct    = precomputed ? null : randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
  const sellAmount = precomputed
    ? sellAmountIn!
    : (tokenBalanceRaw * BigInt(Math.floor(sellPct! * 10000))) / 10000n;
  if (sellAmount === 0n) { record.error = "Sell amount too small"; return record; }

  record.tokenAmount = formatUnits(sellAmount, TOKEN_DECIMALS);
  logger.info({
    wallet: wallet.address, tokenBal: tokenBalanceHuman,
    sellPct: sellPct !== null ? (sellPct * 100).toFixed(1) + "%" : "pre-computed",
    dex: "Aerodrome",
  }, "Executing SELL (Aerodrome)...");

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  try {
    // Step 1: approve Aerodrome router
    const approveGasPrice = await getVariedGasPrice();
    const approveHash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [AERO_ROUTER, sellAmount], gasPrice: approveGasPrice,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") throw new Error(`approve reverted (${approveHash})`);

    await sleep(2000);

    // Step 2: swapExactTokensForETH
    const ethBeforeSwap = await publicClient.getBalance({ address: wallet.address });
    const swapGasPrice  = await getVariedGasPrice();
    const swapHash = await wallet.walletClient.writeContract({
      address:      AERO_ROUTER,
      abi:          AERO_ROUTER_ABI,
      functionName: "swapExactTokensForETH",
      args: [
        sellAmount, 0n,
        [{ from: TOKEN_ADDRESS, to: WETH_ADDRESS, stable: false, factory: AERO_FACTORY }],
        wallet.address,
        deadline,
      ],
      gasPrice: swapGasPrice,
    });
    const swapReceipt   = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const ethAfterSwap  = await publicClient.getBalance({ address: wallet.address });
    const gasCostWei    = swapReceipt.gasUsed * (swapReceipt.effectiveGasPrice ?? swapGasPrice);
    const ethReceivedWei = ethAfterSwap + gasCostWei > ethBeforeSwap
      ? ethAfterSwap + gasCostWei - ethBeforeSwap : 0n;
    const ethReceived = Number(ethReceivedWei) / 1e18;

    record.txHash    = swapHash;
    record.ethAmount = ethReceived;
    record.usdAmount = ethReceived * ethPriceUsd;
    record.success   = true;
    lastSellTimestamp.set(wallet.index, Date.now());
    consecutiveBuys.set(wallet.index, 0);
    rollRebalanceThreshold(wallet.index);
    logger.info({ swapHash, tokensSold: record.tokenAmount, dex: "Aerodrome" }, "SELL Aerodrome confirmed ✅");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "SELL Aerodrome failed");
  }

  sendTradeAlert(record).catch(() => {});
  return record;
}

// ─── Sell ─────────────────────────────────────────────────────────────────────

async function executeSell(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  manual = false,
  sellAmountIn?: bigint,
): Promise<TradeRecord> {
  const precomputed = sellAmountIn !== undefined;
  if (!precomputed) await applyJitter(manual);
  const { raw: tokenBalanceRaw, human: tokenBalanceHuman } = await getTokenBalance(wallet.address);

  const record: TradeRecord = {
    timestamp:    new Date().toISOString(),
    type:         "sell",
    walletIndex:  wallet.index,
    walletAddress: wallet.address,
    ethAmount:    0,
    usdAmount:    0,
    tokenAmount:  "0",
    ethPriceUsd,
    txHash:  null,
    success: false,
    dex:     "Uniswap V3",
  };

  if (tokenBalanceRaw === 0n) {
    record.error = "No token balance to sell";
    logger.warn({ wallet: wallet.address }, "Skipping sell – no token balance");
    return record;
  }

  // ETH guard: sell requires 2 TXs, both need gas
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < MIN_ETH_FOR_SELL) {
    record.error = `Low ETH for gas: ${ethBalance.toFixed(6)} ETH (need ${MIN_ETH_FOR_SELL})`;
    logger.warn(
      { wallet: wallet.address, ethBalance: ethBalance.toFixed(6), minRequired: MIN_ETH_FOR_SELL },
      "Skipping sell – insufficient ETH for gas"
    );
    return record;
  }

  // Cooldown: avoid selling the same wallet twice in quick succession
  const lastSell = lastSellTimestamp.get(wallet.index) ?? 0;
  if (!manual && Date.now() - lastSell < SELL_COOLDOWN_MS) {
    record.error = "Sell cooldown active for this wallet";
    logger.info(
      { wallet: wallet.address, cooldownRemaining: Math.round((SELL_COOLDOWN_MS - (Date.now() - lastSell)) / 60000) + " min" },
      "Skipping sell – cooldown"
    );
    return record;
  }

  const sellPct    = precomputed ? null : randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
  const sellAmount = precomputed
    ? sellAmountIn!
    : (tokenBalanceRaw * BigInt(Math.floor(sellPct! * 10000))) / 10000n;

  if (sellAmount === 0n) {
    record.error = "Sell amount too small";
    return record;
  }

  record.tokenAmount = formatUnits(sellAmount, TOKEN_DECIMALS);

  logger.info(
    {
      wallet:     wallet.address,
      tokenBal:   tokenBalanceHuman,
      sellPct:    sellPct !== null ? (sellPct * 100).toFixed(1) + "%" : "pre-computed",
      sellAmount: record.tokenAmount,
    },
    "Executing SELL (approve → multicall swap+unwrap)..."
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  try {
    // Step 1: approve SwapRouter02 to spend tokens
    logger.info({ wallet: wallet.address }, "Step 1: approving SwapRouter02 for TOKEN...");
    const approveGasPrice = await getVariedGasPrice();
    const approveHash = await wallet.walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi:     ERC20_ABI,
      functionName: "approve",
      args:     [UNI_ROUTER, sellAmount],
      gasPrice: approveGasPrice,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") {
      throw new Error(`TOKEN.approve reverted (hash ${approveHash})`);
    }
    logger.info({ approveHash }, "Approval confirmed ✅");

    // Step 2: multicall(exactInputSingle TOKEN→WETH, unwrapWETH9→wallet)
    await sleep(2000); // wait for RPC to see the approval

    logger.info({ wallet: wallet.address }, "Step 2: swap TOKEN→ETH via multicall...");
    const swapCalldata   = encodeExactInputSingle({
      tokenIn:          TOKEN_ADDRESS,
      tokenOut:         WETH_ADDRESS,
      fee:              UNI_POOL_FEE,
      recipient:        UNI_ROUTER,      // router receives WETH, then unwraps to ETH
      amountIn:         sellAmount,
      amountOutMinimum: 0n,
    });
    const unwrapCalldata = encodeUnwrapWETH9(wallet.address);

    const ethBeforeSwap = await publicClient.getBalance({ address: wallet.address });
    const swapGasPrice  = await getVariedGasPrice();
    const swapHash = await wallet.walletClient.writeContract({
      address: UNI_ROUTER,
      abi:     SWAP_ROUTER_ABI,
      functionName: "multicall",
      args:     [deadline, [swapCalldata, unwrapCalldata]],
      value:    0n,
      gas:      400_000n,
      gasPrice: swapGasPrice,
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });

    // Calculate gross ETH received (add back gas cost so we track token value, not net)
    const ethAfterSwap  = await publicClient.getBalance({ address: wallet.address });
    const gasCostWei    = swapReceipt.gasUsed * (swapReceipt.effectiveGasPrice ?? swapGasPrice);
    const ethReceivedWei = ethAfterSwap + gasCostWei > ethBeforeSwap
      ? ethAfterSwap + gasCostWei - ethBeforeSwap
      : 0n;
    const ethReceived = Number(ethReceivedWei) / 1e18;

    record.txHash   = swapHash;
    record.ethAmount = ethReceived;
    record.usdAmount = ethReceived * ethPriceUsd;
    record.success  = true;
    lastSellTimestamp.set(wallet.index, Date.now());
    consecutiveBuys.set(wallet.index, 0); // reset rebalance counter
    const newThreshold = rollRebalanceThreshold(wallet.index); // re-roll next sell trigger
    logger.info({ swapHash, tokensSold: record.tokenAmount, nextRebalanceAt: newThreshold + " buys" }, "SELL confirmed ✅");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "SELL failed");
  }

  sendTradeAlert(record).catch(() => {}); // fire-and-forget
  return record;
}

// ─── GBLIN Contract Buy ───────────────────────────────────────────────────────

async function executeBuyGblinContract(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  ethWei: bigint,
  usdAmount: number,
  manual = false
): Promise<TradeRecord> {
  const ethAmount = Number(ethWei) / 1e18;
  const record: TradeRecord = {
    timestamp:     new Date().toISOString(),
    type:          "buy",
    walletIndex:   wallet.index,
    walletAddress: wallet.address,
    ethAmount,
    usdAmount,
    tokenAmount:   "0",
    ethPriceUsd,
    txHash:        null,
    success:       false,
    dex:           "GBLIN",
  };

  // Enforce contract minimum: 0.0005 ETH
  const safeEthWei = ethWei < GBLIN_MIN_ETH_WEI ? GBLIN_MIN_ETH_WEI : ethWei;
  const safeEthAmount = Number(safeEthWei) / 1e18;
  if (safeEthWei !== ethWei) {
    logger.info({ original: ethAmount.toFixed(6), clamped: safeEthAmount.toFixed(6) }, "GBLIN buy clamped to minimum 0.0005 ETH");
  }

  logger.info({ wallet: wallet.address, usd: usdAmount.toFixed(4), ethWei: safeEthWei.toString(), dex: "GBLIN contract" }, "Executing BUY (GBLIN contract)...");

  try {
    const gasPrice = await getVariedGasPrice();
    const hash = await wallet.walletClient.writeContract({
      address:      TOKEN_ADDRESS,
      abi:          GBLIN_CONTRACT_ABI,
      functionName: "buyGBLIN",
      args:         [0n], // minGblinOut = 0 (best-execution already verified)
      value:        safeEthWei,
      gas:          3_000_000n, // V6 buyGBLIN does internal basket swaps (cbBTC/USDC) — needs ample gas
      gasPrice,
    });
    const tokBefore = await getTokenBalance(wallet.address);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    record.txHash = hash;
    if (receipt.status !== "success") {
      record.error = `buyGBLIN reverted on-chain (${hash})`;
      logger.error({ hash, status: receipt.status }, "BUY GBLIN contract FAILED on-chain ❌");
      sendTradeAlert(record).catch(() => {});
      return record;
    }
    const tokAfter  = await getTokenBalance(wallet.address);
    record.tokenAmount = formatUnits(
      tokAfter.raw > tokBefore.raw ? tokAfter.raw - tokBefore.raw : 0n,
      TOKEN_DECIMALS
    );
    record.success = true;
    consecutiveBuys.set(wallet.index, (consecutiveBuys.get(wallet.index) ?? 0) + 1);
    lastGblinBuyTimestamp.set(wallet.index, Date.now()); // start 2-min sell lock
    recordGblinContractBuyUsed();                        // track daily quota
    logger.info({ hash, usd: usdAmount.toFixed(4), gblinReceived: record.tokenAmount, dex: "GBLIN contract", gblinBuysToday: gblinContractBuyCountToday }, "BUY GBLIN contract confirmed ✅");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "BUY GBLIN contract failed");
  }

  sendTradeAlert(record).catch(() => {});
  return record;
}

// ─── GBLIN Contract Sell ──────────────────────────────────────────────────────

async function executeSellGblinContract(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  sellAmount: bigint,
  manual = false
): Promise<TradeRecord> {
  const record: TradeRecord = {
    timestamp:     new Date().toISOString(),
    type:          "sell",
    walletIndex:   wallet.index,
    walletAddress: wallet.address,
    ethAmount:     0,
    usdAmount:     0,
    tokenAmount:   formatUnits(sellAmount, TOKEN_DECIMALS),
    ethPriceUsd,
    txHash:        null,
    success:       false,
    dex:           "GBLIN",
  };

  logger.info({ wallet: wallet.address, tokens: record.tokenAmount, dex: "GBLIN contract" }, "Executing SELL (GBLIN contract)...");

  try {
    // Step 1: approve GBLIN contract to spend tokens (spender = contract itself)
    const approveGasPrice = await getVariedGasPrice();
    const approveHash = await wallet.walletClient.writeContract({
      address:      TOKEN_ADDRESS,
      abi:          ERC20_ABI,
      functionName: "approve",
      args:         [TOKEN_ADDRESS, sellAmount],
      gasPrice:     approveGasPrice,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") throw new Error(`approve reverted (${approveHash})`);

    await sleep(2000);

    // Step 2: sellGBLINForEth
    const ethBeforeSwap = await publicClient.getBalance({ address: wallet.address });
    const swapGasPrice  = await getVariedGasPrice();
    const swapHash = await wallet.walletClient.writeContract({
      address:      TOKEN_ADDRESS,
      abi:          GBLIN_CONTRACT_ABI,
      functionName: "sellGBLINForEth",
      args:         [sellAmount, 0n], // minEthOut = 0 (best-execution already verified)
      gas:          3_000_000n, // V6 sellGBLINForEth swaps basket back to ETH — needs ample gas
      gasPrice:     swapGasPrice,
    });
    const swapReceipt  = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const ethAfterSwap = await publicClient.getBalance({ address: wallet.address });
    const gasCostWei   = swapReceipt.gasUsed * (swapReceipt.effectiveGasPrice ?? swapGasPrice);
    const ethReceivedWei = ethAfterSwap + gasCostWei > ethBeforeSwap
      ? ethAfterSwap + gasCostWei - ethBeforeSwap : 0n;
    const ethReceived  = Number(ethReceivedWei) / 1e18;

    record.txHash    = swapHash;
    record.ethAmount = ethReceived;
    record.usdAmount = ethReceived * ethPriceUsd;
    record.success   = true;
    lastSellTimestamp.set(wallet.index, Date.now());
    consecutiveBuys.set(wallet.index, 0);
    rollRebalanceThreshold(wallet.index);
    logger.info({ swapHash, tokensSold: record.tokenAmount, dex: "GBLIN contract" }, "SELL GBLIN contract confirmed ✅");
  } catch (err) {
    record.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.error({ err }, "SELL GBLIN contract failed");
  }

  sendTradeAlert(record).catch(() => {});
  return record;
}

// ─── Best-execution buy/sell wrappers ─────────────────────────────────────────

/**
 * Quotes all 3 venues, picks the best for BUY, then executes.
 * Jitter is applied here (once) before quoting so timing stays human.
 */
async function bestExecutionBuy(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  manual = false
): Promise<TradeRecord> {
  await applyJitter(manual);
  const usdAmount = selectBuyAmountUsd();
  const ethAmount = usdAmount / ethPriceUsd;
  const ethWei    = parseEther(ethAmount.toFixed(18));

  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < ethAmount + 0.0002) {
    return {
      timestamp: new Date().toISOString(), type: "buy",
      walletIndex: wallet.index, walletAddress: wallet.address,
      ethAmount, usdAmount, tokenAmount: "0", ethPriceUsd,
      txHash: null, success: false,
      error: `Low ETH balance: ${ethBalance.toFixed(6)} ETH`,
    };
  }

  // ── Daily minimum: each venue must execute ≥1 buy per day ──────────────────
  const forcedVenue = getForcedBuyVenue();
  if (forcedVenue) {
    logger.info({ forcedVenue }, "Daily forced-buy: overriding best-execution to ensure venue diversity");
    if (forcedVenue === "uniswap") {
      const record = await executeBuy(wallet, ethPriceUsd, manual, ethWei, usdAmount);
      if (record.success) recordVenueBuyUsed("uniswap");
      return record;
    } else {
      const record = await executeBuyAerodrome(wallet, ethPriceUsd, manual, ethWei, usdAmount);
      if (record.success) recordVenueBuyUsed("aerodrome");
      return record;
    }
  }

  // ── Normal best-execution routing ───────────────────────────────────────────
  const gblinAllowed = isGblinContractBuyAllowed();
  const best = await findBestBuyVenue(ethWei, !gblinAllowed).catch(() => null);
  if (!best) {
    // All quotes failed — fall back to Aerodrome with same amounts
    logger.warn("All buy quotes failed – falling back to Aerodrome");
    const record = await executeBuyAerodrome(wallet, ethPriceUsd, true, ethWei, usdAmount);
    if (record.success) recordVenueBuyUsed("aerodrome");
    return record;
  }

  if (best.venue === "uniswap") {
    const record = await executeBuy(wallet, ethPriceUsd, manual, ethWei, usdAmount);
    if (record.success) recordVenueBuyUsed("uniswap");
    return record;
  }
  if (best.venue === "gblin") {
    return executeBuyGblinContract(wallet, ethPriceUsd, ethWei, usdAmount, manual);
  }
  const record = await executeBuyAerodrome(wallet, ethPriceUsd, manual, ethWei, usdAmount);
  if (record.success) recordVenueBuyUsed("aerodrome");
  return record;
}

/**
 * Quotes all 3 venues, picks the best for SELL, then executes.
 */
async function bestExecutionSell(
  wallet: ReturnType<typeof getOrCreateWallets>[number],
  ethPriceUsd: number,
  manual = false
): Promise<TradeRecord> {
  await applyJitter(manual);
  const { raw: tokenBalanceRaw, human: tokenBalanceHuman } = await getTokenBalance(wallet.address);

  if (tokenBalanceRaw === 0n) {
    return {
      timestamp: new Date().toISOString(), type: "sell",
      walletIndex: wallet.index, walletAddress: wallet.address,
      ethAmount: 0, usdAmount: 0, tokenAmount: "0", ethPriceUsd,
      txHash: null, success: false, error: "No token balance to sell",
    };
  }
  const ethBalance = await getEthBalance(wallet.address);
  if (ethBalance < MIN_ETH_FOR_SELL) {
    return {
      timestamp: new Date().toISOString(), type: "sell",
      walletIndex: wallet.index, walletAddress: wallet.address,
      ethAmount: 0, usdAmount: 0, tokenAmount: "0", ethPriceUsd,
      txHash: null, success: false,
      error: `Low ETH for gas: ${ethBalance.toFixed(6)} ETH (need ${MIN_ETH_FOR_SELL})`,
    };
  }
  const lastSell = lastSellTimestamp.get(wallet.index) ?? 0;
  if (!manual && Date.now() - lastSell < SELL_COOLDOWN_MS) {
    return {
      timestamp: new Date().toISOString(), type: "sell",
      walletIndex: wallet.index, walletAddress: wallet.address,
      ethAmount: 0, usdAmount: 0, tokenAmount: "0", ethPriceUsd,
      txHash: null, success: false, error: "Sell cooldown active for this wallet",
    };
  }

  const sellPct    = randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
  const sellAmount = (tokenBalanceRaw * BigInt(Math.floor(sellPct * 10000))) / 10000n;
  if (sellAmount === 0n) {
    return {
      timestamp: new Date().toISOString(), type: "sell",
      walletIndex: wallet.index, walletAddress: wallet.address,
      ethAmount: 0, usdAmount: 0, tokenAmount: "0", ethPriceUsd,
      txHash: null, success: false, error: "Sell amount too small",
    };
  }

  logger.info({ wallet: wallet.address, tokenBal: tokenBalanceHuman, sellPct: (sellPct * 100).toFixed(1) + "%" }, "Quoting best sell venue...");

  const best = await findBestSellVenue(sellAmount, wallet.index).catch(() => null);
  if (!best) {
    logger.warn("All sell quotes failed – falling back to Aerodrome");
    return executeSellAerodrome(wallet, ethPriceUsd, true, sellAmount);
  }

  if (best.venue === "uniswap") {
    return executeSell(wallet, ethPriceUsd, manual, sellAmount);
  }
  if (best.venue === "gblin") {
    return executeSellGblinContract(wallet, ethPriceUsd, sellAmount, manual);
  }
  return executeSellAerodrome(wallet, ethPriceUsd, manual, sellAmount);
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

/** Errors that mean "nothing went wrong technically, just skip" – no retry. */
const SKIP_ERRORS = [
  "No token balance",
  "Low ETH balance",
  "Sell amount too small",
  "cooldown",
];

/**
 * Runs a trade executor up to `maxAttempts` times.
 * Waits 30–60 s between attempts so gas conditions can settle.
 * Does NOT retry on "skip" errors (no balance, cooldown, etc.).
 */
async function withRetry(
  fn: () => Promise<TradeRecord>,
  maxAttempts = 3
): Promise<TradeRecord> {
  let lastRecord!: TradeRecord;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastRecord = await fn();
    if (lastRecord.success) return lastRecord;

    const isSkip = SKIP_ERRORS.some((s) => lastRecord.error?.includes(s));
    if (isSkip || attempt === maxAttempts) return lastRecord;

    const waitMs = randomBetween(30_000, 60_000);
    logger.warn(
      { attempt, maxAttempts, waitSec: (waitMs / 1000).toFixed(0), error: lastRecord.error?.slice(0, 80) },
      "Trade failed – retrying..."
    );
    await sleep(waitMs);
  }
  return lastRecord;
}

// ─── Trade dispatcher ─────────────────────────────────────────────────────────

async function executeTrade(ethPriceUsd: number): Promise<TradeRecord> {
  const wallets = getOrCreateWallets();

  // ── Skip trade (12 %) ───────────────────────────────────────────────────────
  // Simulates a human who glances at the chart and decides not to trade.
  // Returns a no-op record so the scheduler continues normally.
  if (Math.random() < 0.12) {
    logger.info("Skipping trade this cycle (human-like hesitation)");
    return {
      timestamp:     new Date().toISOString(),
      type:          "buy",
      walletIndex:   0,
      walletAddress: wallets[0]!.address,
      ethAmount:     0,
      usdAmount:     0,
      tokenAmount:   "0",
      ethPriceUsd,
      txHash:        null,
      success:       false,
      error:         "skipped",
    };
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Rebalance override ──────────────────────────────────────────────────────
  // Each wallet has its own random threshold (2–6), re-rolled after every sell.
  const rebalanceCandidate = wallets.find(
    (w) => (consecutiveBuys.get(w.index) ?? 0) >= getRebalanceThreshold(w.index)
  );
  if (rebalanceCandidate) {
    logger.info(
      {
        wallet: rebalanceCandidate.address,
        consecutiveBuys: consecutiveBuys.get(rebalanceCandidate.index),
        threshold: getRebalanceThreshold(rebalanceCandidate.index),
      },
      "Rebalance: forcing SELL (best execution)"
    );
    return withRetry(() => bestExecutionSell(rebalanceCandidate, ethPriceUsd));
  }
  // ────────────────────────────────────────────────────────────────────────────

  const sellProb = await navAwareSellProbability(ethPriceUsd);
  const isSell   = Math.random() < sellProb;

  if (isSell) {
    // For sells, pick only wallets that hold tokens and aren't in cooldown
    const eligible = wallets.filter((w) => {
      const lastSell = lastSellTimestamp.get(w.index) ?? 0;
      const cooldownOk = Date.now() - lastSell >= SELL_COOLDOWN_MS;
      const sw = state.wallets.find((x) => x.index === w.index);
      const cachedEth = sw?.ethBalance ?? 1;
      const cachedTok = parseFloat(sw?.tokenBalance ?? "0");
      // Must actually hold GBLIN to sell, plus gas; otherwise fall back to BUY
      // (best-execution then mints at NAV on the contract = buy low).
      return cooldownOk && cachedTok > 0 && cachedEth >= MIN_ETH_FOR_SELL;
    });

    if (eligible.length > 0) {
      // Weighted selection among eligible wallets
      const eligibleWeights = eligible.map((w) => WALLET_WEIGHTS[w.index] ?? 0.25);
      const totalW = eligibleWeights.reduce((a, b) => a + b, 0);
      const r = Math.random() * totalW;
      let cum = 0;
      let chosen = eligible[0]!;
      for (let i = 0; i < eligible.length; i++) {
        cum += eligibleWeights[i]!;
        if (r < cum) { chosen = eligible[i]!; break; }
      }
      logger.info({ sellProbability: (sellProb * 100).toFixed(0) + "%" }, "Trade type: SELL (best execution)");
      return withRetry(() => bestExecutionSell(chosen, ethPriceUsd));
    }
    // All wallets in cooldown → fallback to buy
    logger.info("All wallets in sell cooldown – falling back to BUY");
  }

  // Weighted wallet selection for buys
  const walletIdx = selectWalletIndex();
  const wallet    = wallets[walletIdx]!;
  logger.info({ sellProbability: (sellProb * 100).toFixed(0) + "%" }, "Trade type: BUY (best execution)");
  return withRetry(() => bestExecutionBuy(wallet, ethPriceUsd));
}

// ─── Balance refresh ──────────────────────────────────────────────────────────

async function refreshBalances(ethPriceUsd: number) {
  const ws = getOrCreateWallets();
  const results: WalletInfo[] = [];

  // Refresh GBLIN price in the background (non-blocking, updates state)
  getGblinPriceUsd().catch(() => {});

  for (const w of ws) {
    try {
      const eth = await getEthBalance(w.address);
      await sleep(100);
      const tok = await getTokenBalance(w.address);
      if (eth < MIN_ETH_FOR_SELL) {
        logger.warn(
          { wallet: w.address, ethBalance: eth.toFixed(6), minForSell: MIN_ETH_FOR_SELL },
          "⚠️  Wallet low on ETH – will be skipped for sells"
        );
      }
      const gblinPrice = state.gblinPriceUsd || 0;
      const tokenUsd   = parseFloat((parseFloat(tok.human) * gblinPrice).toFixed(2));
      results.push({
        index:           w.index,
        address:         w.address,
        ethBalance:      eth,
        usdBalance:      parseFloat((eth * ethPriceUsd).toFixed(2)),
        tokenBalance:    tok.human,
        tokenBalanceUsd: tokenUsd,
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

// ─── Scheduler ────────────────────────────────────────────────────────────────

/** Hard cap on any single interval — prevents extreme waits during night + rest multiplier combos */
const MAX_INTERVAL_MS = 75 * 60_000; // 75 min absolute ceiling

async function scheduleNextTrade() {
  if (!isRunning) return;

  let intervalMs = getIntervalMs();

  // 8 % chance of an "unplanned break" — the trader got distracted or stepped away.
  if (Math.random() < 0.08) {
    const restMultiplier = randomBetween(1.3, 1.7);
    intervalMs = Math.round(intervalMs * restMultiplier);
    logger.info({ restMultiplier: restMultiplier.toFixed(2) }, "Unplanned break – extending interval");
  }

  // Hard cap: never wait more than 120 min regardless of zone or multipliers
  if (intervalMs > MAX_INTERVAL_MS) {
    logger.info({ cappedFrom: Math.round(intervalMs / 60000) + " min", cappedTo: "75 min" }, "Interval capped at maximum");
    intervalMs = MAX_INTERVAL_MS;
  }

  const intervalSec = Math.round(intervalMs / 1000);
  const nextAt      = new Date(Date.now() + intervalMs).toISOString();

  state.nextTradeAt     = nextAt;
  state.nextIntervalSec = intervalSec;

  const now  = new Date();
  const hour = now.getUTCHours();
  const zone  = hour < 6 ? "night" : (hour >= 14 && hour < 16) ? "peak-US" : "normal";

  logger.info(
    { nextIn: `${(intervalMs / 60000).toFixed(1)} min`, nextAt, zone },
    "Next trade scheduled"
  );

  heartbeatTimeout = setTimeout(async () => {
    state.nextTradeAt = null;
    state.nextIntervalSec = null;
    if (!isRunning) return;

    try {
      const ethPrice = await getEthPriceUsd();
      state.ethPriceUsd = ethPrice;
      state.lastCheck   = new Date().toISOString();

      await distributeFunds(ethPrice);

      const record = await executeTrade(ethPrice);

      prevEthPriceUsd = ethPrice;

      if (record.success) state.lastTrade = record;
      state.totalTrades += 1;
      if (record.type === "buy")  state.totalBuys  += 1;
      if (record.type === "sell") state.totalSells += 1;
      state.recentTrades = [record, ...state.recentTrades].slice(0, 200);
      persistTrades();

      await refreshBalances(ethPrice);
    } catch (err) {
      logger.error({ err }, "Heartbeat cycle error — rescheduling anyway");
    } finally {
      scheduleNextTrade();
    }
  }, intervalMs);
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

/**
 * Watchdog: runs every 5 minutes.
 * If the bot is marked "running" but nextTradeAt is null and no timeout is
 * pending, the scheduler has silently died — kick it back to life.
 */
function startWatchdog(): void {
  setInterval(() => {
    if (!isRunning) return;
    if (heartbeatTimeout !== null) return; // scheduler is alive
    if (state.nextTradeAt !== null) return; // already scheduled
    logger.warn("Watchdog: scheduler appears dead — restarting it");
    scheduleNextTrade();
  }, 5 * 60_000);
}

// ─── Funding check ────────────────────────────────────────────────────────────

async function checkFunding() {
  try {
    const ethPrice    = await getEthPriceUsd();
    state.ethPriceUsd = ethPrice;
    state.lastCheck   = new Date().toISOString();

    await refreshBalances(ethPrice);

    const totalUsd = state.wallets.reduce((s, w) => s + w.usdBalance, 0);
    logger.info({ totalUsd: totalUsd.toFixed(2), threshold: FUNDED_THRESHOLD_USD }, "Balance check");

    if (totalUsd >= FUNDED_THRESHOLD_USD) {
      logger.info("Wallets funded! Starting organic heartbeat...");
      state.status = "running";
      isRunning    = true;
      if (!botStartedAt) botStartedAt = Date.now(); // record first run time

      if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }

      await distributeFunds(ethPrice);
      await refreshBalances(ethPrice);
      scheduleNextTrade();
    }
  } catch (err) {
    logger.error({ err }, "Error during funding check");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startBot() {
  try {
    logger.info("Bot initializing – organic buy/sell mode (time-aware, weighted wallets)...");
    loadPersistedTrades(); // restore counters and history from disk
    const ws = getOrCreateWallets();

    state.wallets = ws.map((w) => ({
      index:           w.index,
      address:         w.address,
      ethBalance:      0,
      usdBalance:      0,
      tokenBalance:    "0",
      tokenBalanceUsd: 0,
    }));

    // Warm up GBLIN price at startup
    getGblinPriceUsd().catch(() => {});

    state.status = "waiting_for_funds";

    logger.info(
      {
        wallets:       ws.map((w) => ({ index: w.index, address: w.address })),
        network:       "Base Mainnet",
        threshold:     `$${FUNDED_THRESHOLD_USD}`,
        token:         TOKEN_ADDRESS,
        uniPool:       "0xAb305c45F4E42A73909a49a6775e3f7782239dAE",
        aeroPool:      AERO_POOL,
        uniRouter:     UNI_ROUTER,
        aeroRouter:    AERO_ROUTER,
        buyPresets:    BUY_PRESETS.map((p) => `$${p.amount}(${(p.weight * 100).toFixed(0)}%)`).join(" "),
        walletWeights: WALLET_WEIGHTS.map((w, i) => `W${i}:${(w * 100).toFixed(0)}%`).join(" "),
        sellProbBase:  (SELL_PROBABILITY_BASE * 100).toFixed(0) + "%",
        sellCooldown:  SELL_COOLDOWN_MS / 60000 + " min",
        intervalMode:  "time-aware (night/peak/normal/weekend)",
      },
      "Bot ready — waiting for funds"
    );

    await checkFunding();

    if (state.status === "waiting_for_funds") {
      pollingTimer = setInterval(checkFunding, POLLING_INTERVAL_MS);
    }

    startWatchdog();
    logger.info("Watchdog started — scheduler will be auto-revived if it dies");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.status      = "error";
    state.errorMessage = msg;
    logger.error({ err }, "Bot failed to initialize");
  }
}

export function getBotState(): BotState {
  return { ...state };
}

function _recordTrade(record: TradeRecord, type: "buy" | "sell") {
  if (record.success) state.lastTrade = record;
  state.totalTrades += 1;
  if (type === "buy")  state.totalBuys  += 1;
  else                 state.totalSells += 1;
  state.recentTrades = [record, ...state.recentTrades].slice(0, 200);
  persistTrades();
  refreshBalances(state.ethPriceUsd).catch(() => {});
}

export function triggerBuyNow(): void {
  if (!isRunning) return;
  logger.info("Manual BUY triggered (best execution)");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return bestExecutionBuy(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "buy"))
    .catch((err) => logger.error({ err }, "Manual BUY failed"));
}

export function triggerSellNow(): void {
  if (!isRunning) return;
  logger.info("Manual SELL triggered (best execution)");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return bestExecutionSell(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "sell"))
    .catch((err) => logger.error({ err }, "Manual SELL failed"));
}

export function triggerBuyUniswap(): void {
  if (!isRunning) return;
  logger.info("Manual BUY forced → Uniswap V3");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeBuy(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "buy"))
    .catch((err) => logger.error({ err }, "Manual BUY Uniswap failed"));
}

export function triggerBuyAerodrome(): void {
  if (!isRunning) return;
  logger.info("Manual BUY forced → Aerodrome V1");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeBuyAerodrome(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "buy"))
    .catch((err) => logger.error({ err }, "Manual BUY Aerodrome failed"));
}

export function triggerSellUniswap(): void {
  if (!isRunning) return;
  logger.info("Manual SELL forced → Uniswap V3");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeSell(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "sell"))
    .catch((err) => logger.error({ err }, "Manual SELL Uniswap failed"));
}

export function triggerSellAerodrome(): void {
  if (!isRunning) return;
  logger.info("Manual SELL forced → Aerodrome V1");
  getEthPriceUsd().then((p) => {
    state.ethPriceUsd = p;
    return executeSellAerodrome(selectBestFundedWallet(), p, true);
  }).then((r) => _recordTrade(r, "sell"))
    .catch((err) => logger.error({ err }, "Manual SELL Aerodrome failed"));
}

export function triggerBuyGblinContract(): void {
  if (!isRunning) return;
  logger.info("Manual BUY forced → GBLIN contract");
  getEthPriceUsd().then(async (p) => {
    state.ethPriceUsd = p;
    const wallet    = selectBestFundedWallet();
    const usdAmount = selectBuyAmountUsd();
    const ethAmount = usdAmount / p;
    const ethWei    = parseEther(ethAmount.toFixed(18));
    return executeBuyGblinContract(wallet, p, ethWei, usdAmount, true);
  }).then((r) => _recordTrade(r, "buy"))
    .catch((err) => logger.error({ err }, "Manual BUY GBLIN contract failed"));
}

export function triggerSellGblinContract(): void {
  if (!isRunning) return;
  logger.info("Manual SELL forced → GBLIN contract");
  getEthPriceUsd().then(async (p) => {
    state.ethPriceUsd = p;
    // For the sell test pick the wallet with the most GBLIN tokens
    const ws = getOrCreateWallets();
    const balances = await Promise.all(ws.map(w => getTokenBalance(w.address).then(b => ({ w, raw: b.raw }))));
    const best = balances.reduce((a, b) => b.raw > a.raw ? b : a, balances[0]!);
    const wallet = best.w;
    if (best.raw === 0n) throw new Error("No token balance in any wallet");
    const sellPct    = randomBetween(SELL_PCT_MIN, SELL_PCT_MAX);
    const sellAmount = (best.raw * BigInt(Math.floor(sellPct * 10000))) / 10000n;
    logger.info({ wallet: wallet.address, tokens: formatUnits(best.raw, TOKEN_DECIMALS) }, "SELL GBLIN test — wallet selected by token balance");
    return executeSellGblinContract(wallet, p, sellAmount, true);
  }).then((r) => _recordTrade(r, "sell"))
    .catch((err) => logger.error({ err }, "Manual SELL GBLIN contract failed"));
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function getMetrics() {
  const trades = state.recentTrades;

  // Uptime
  const uptimeSec = botStartedAt ? Math.round((Date.now() - botStartedAt) / 1000) : 0;
  const uptimeHuman = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
    ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  // Success rate
  const successful = trades.filter((t) => t.success).length;
  const successRate = trades.length > 0 ? ((successful / trades.length) * 100).toFixed(1) + "%" : "N/A";

  // Buy stats
  const buys  = trades.filter((t) => t.type === "buy"  && t.success);
  const sells = trades.filter((t) => t.type === "sell" && t.success);
  const avgBuyUsd  = buys.length  > 0 ? (buys.reduce((s, t)  => s + t.usdAmount, 0) / buys.length).toFixed(4)  : "N/A";
  const avgSellUsd = sells.length > 0 ? (sells.reduce((s, t) => s + t.usdAmount, 0) / sells.length).toFixed(4) : "N/A";

  // Per-wallet breakdown
  const walletStats = Array.from({ length: 4 }, (_, i) => {
    const wb = trades.filter((t) => t.walletIndex === i);
    return {
      walletIndex:    i,
      address:        state.wallets.find((w) => w.index === i)?.address ?? "",
      totalTrades:    wb.length,
      buys:           wb.filter((t) => t.type === "buy").length,
      sells:          wb.filter((t) => t.type === "sell").length,
      successfulTrades: wb.filter((t) => t.success).length,
      consecutiveBuys: consecutiveBuys.get(i) ?? 0,
      inSellCooldown: (Date.now() - (lastSellTimestamp.get(i) ?? 0)) < SELL_COOLDOWN_MS,
    };
  });

  // Volume
  const totalVolumeBuyUsd  = buys.reduce((s, t)  => s + t.usdAmount, 0);
  const totalVolumeSellUsd = sells.reduce((s, t) => s + t.usdAmount, 0);

  return {
    uptime:    uptimeHuman,
    uptimeSec,
    startedAt: botStartedAt ? new Date(botStartedAt).toISOString() : null,
    status:    state.status,
    ethPriceUsd: state.ethPriceUsd,

    summary: {
      totalTrades:         state.totalTrades,
      totalBuys:           state.totalBuys,
      totalSells:          state.totalSells,
      successRate,
      avgBuyUsd,
      avgSellUsd,
      totalVolumeBuyUsd:  totalVolumeBuyUsd.toFixed(4),
      totalVolumeSellUsd: totalVolumeSellUsd.toFixed(4),
    },

    rebalance: {
      thresholdRange: "2–6 per wallet (random, re-rolled after each sell)",
      walletCounters: Array.from({ length: 4 }, (_, i) => ({
        walletIndex:      i,
        consecutiveBuys:  consecutiveBuys.get(i) ?? 0,
        currentThreshold: getRebalanc