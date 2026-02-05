/**
 * Notifications Module
 *
 * Handles trade alerts via Telegram (and optionally Discord).
 * Sends formatted messages for trade entries and exits.
 */

import type { HarnessContext } from "./context";

export interface TradeAlertData {
  symbol: string;
  side: "BUY" | "SELL";
  quantity?: number;
  price?: number;
  pnlPercent?: number;
  reason?: string;
  market: "stock" | "crypto" | "dex";
  /** Additional details to include */
  details?: Record<string, string | number>;
}

/**
 * Send a raw message to Telegram
 */
export async function sendTelegramNotification(
  ctx: HarnessContext,
  message: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<void> {
  const token = ctx.env.TELEGRAM_BOT_TOKEN;
  const chatId = ctx.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return; // Telegram not configured
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      ctx.log("Telegram", "send_failed", { status: response.status, error });
    } else {
      ctx.log("Telegram", "message_sent", { length: message.length });
    }
  } catch (error) {
    ctx.log("Telegram", "send_error", { error: String(error) });
  }
}

/**
 * Format a number as USD currency
 */
function formatUsd(value: number): string {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  } else if (value >= 0.01) {
    return `$${value.toFixed(4)}`;
  } else {
    return `$${value.toFixed(8)}`;
  }
}

/**
 * Format a percentage with sign
 */
function formatPnl(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  const emoji = pct >= 0 ? " ✅" : " ❌";
  return `${sign}${pct.toFixed(1)}%${emoji}`;
}

/**
 * Send a formatted trade alert
 */
export async function sendTradeAlert(
  ctx: HarnessContext,
  type: "entry" | "exit",
  data: TradeAlertData
): Promise<void> {
  const emoji = type === "entry" ? "🟢" : "🔴";
  const action = type === "entry" ? "ENTRY" : "EXIT";
  const marketLabel = data.market.toUpperCase();

  let message = `${emoji} <b>${action}: ${data.symbol}</b>\n\n`;
  message += `<b>Market:</b> ${marketLabel}\n`;

  if (data.price !== undefined) {
    message += `<b>Price:</b> ${formatUsd(data.price)}\n`;
  }

  if (data.quantity !== undefined) {
    message += `<b>Size:</b> ${data.quantity.toFixed(4)}\n`;
  }

  if (data.pnlPercent !== undefined) {
    message += `<b>P&L:</b> ${formatPnl(data.pnlPercent)}\n`;
  }

  if (data.reason) {
    message += `<b>Reason:</b> ${data.reason}\n`;
  }

  // Add any extra details
  if (data.details) {
    for (const [key, value] of Object.entries(data.details)) {
      const formattedValue = typeof value === "number" ? value.toFixed(2) : value;
      message += `<b>${key}:</b> ${formattedValue}\n`;
    }
  }

  await sendTelegramNotification(ctx, message, "HTML");
}
