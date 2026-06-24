import { logger } from "./logger.js";

/**
 * Sends an alert to a configured webhook URL after a trade.
 *
 * Supports two integrations (configured via env vars):
 *
 * 1. Discord webhook:
 *    DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *    Payload: { username, content, embeds }
 *
 * 2. Telegram bot:
 *    TELEGRAM_BOT_TOKEN=123456:AAAA...
 *    TELEGRAM_CHAT_ID=-100123456789
 *    Calls: https://api.telegram.org/bot{TOKEN}/sendMessage
 *
 * If neither is configured the function is a no-op.
 */

interface TradeAlert {
  type:         "buy" | "sell";
  walletIndex:  number;
  walletAddress: string;
  usdAmount:    number;
  tokenAmount:  string | undefined;
  ethAmount:    number;
  txHash:       string | null;
  success:      boolean;
  ethPriceUsd:  number;
  error?:       string;
}

function emoji(type: "buy" | "sell", success: boolean): string {
  if (!success) return "❌";
  return type === "buy" ? "🟢" : "🔴";
}

function buildDiscordPayload(alert: TradeAlert): object {
  const icon  = emoji(alert.type, alert.success);
  const label = alert.type.toUpperCase();
  const color = alert.success
    ? (alert.type === "buy" ? 0x00c26f : 0xff4444)
    : 0x888888;

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Wallet", value: `W${alert.walletIndex} \`${alert.walletAddress.slice(0, 10)}…\``, inline: true },
    { name: "USD",    value: `$${alert.usdAmount.toFixed(4)}`,  inline: true },
    { name: "ETH",    value: `${alert.ethAmount.toFixed(6)}`,   inline: true },
    { name: "Tokens", value: alert.tokenAmount ?? "—",           inline: true },
    { name: "ETH/USD",value: `$${alert.ethPriceUsd.toFixed(2)}`, inline: true },
  ];

  if (alert.txHash) {
    fields.push({ name: "TX", value: `[${alert.txHash.slice(0, 10)}…](https://basescan.org/tx/${alert.txHash})`, inline: false });
  }
  if (alert.error) {
    fields.push({ name: "Error", value: alert.error.slice(0, 200), inline: false });
  }

  return {
    username: "TradingBot",
    embeds: [{
      title:       `${icon} ${label} ${alert.success ? "confirmed" : "FAILED"}`,
      color,
      fields,
      timestamp:   new Date().toISOString(),
      footer:      { text: "Base Mainnet" },
    }],
  };
}

function buildTelegramPayload(chatId: string, alert: TradeAlert): object {
  const icon  = emoji(alert.type, alert.success);
  const label = alert.type.toUpperCase();
  const status = alert.success ? "✅ confirmed" : "❌ FAILED";

  const lines = [
    `${icon} <b>${label} ${status}</b>`,
    `Wallet: W${alert.walletIndex} <code>${alert.walletAddress.slice(0, 12)}…</code>`,
    `Amount: <b>$${alert.usdAmount.toFixed(4)}</b> (${alert.ethAmount.toFixed(6)} ETH)`,
    `Tokens: ${alert.tokenAmount ?? "—"}`,
    `ETH price: $${alert.ethPriceUsd.toFixed(2)}`,
  ];
  if (alert.txHash) {
    lines.push(`TX: <a href="https://basescan.org/tx/${alert.txHash}">${alert.txHash.slice(0, 12)}…</a>`);
  }
  if (alert.error) {
    lines.push(`Error: <code>${alert.error.slice(0, 200)}</code>`);
  }

  return {
    chat_id:    chatId,
    text:       lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
}

export async function sendTradeAlert(alert: TradeAlert): Promise<void> {
  // Only notify on FAILED transactions. Successful buys/sells stay silent —
  // the user does not want a ping on every trade (low-ETH alerts are separate).
  if (alert.success) return;
  const discordUrl    = process.env["DISCORD_WEBHOOK_URL"];
  const telegramToken = process.env["TELEGRAM_BOT_TOKEN"];
  const telegramChat  = process.env["TELEGRAM_CHAT_ID"];

  const tasks: Promise<void>[] = [];

  // ── Discord ─────────────────────────────────────────────────────────────────
  if (discordUrl) {
    tasks.push(
      fetch(discordUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(buildDiscordPayload(alert)),
      })
      .then((r) => {
        if (!r.ok) throw new Error(`Discord webhook returned ${r.status}`);
        logger.debug("Discord alert sent");
      })
      .catch((err) => logger.warn({ err }, "Discord webhook failed"))
    );
  }

  // ── Telegram ─────────────────────────────────────────────────────────────────
  if (telegramToken && telegramChat) {
    const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
    tasks.push(
      fetch(telegramUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(buildTelegramPayload(telegramChat, alert)),
      })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`Telegram returned ${r.status}: ${body}`);
        }
        logger.debug("Telegram alert sent");
      })
      .catch((err) => logger.warn({ err }, "Telegram webhook failed"))
    );
  }

  if (tasks.length === 0) return; // no webhook configured – no-op

  await Promise.allSettled(tasks);
}
