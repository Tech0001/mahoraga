/**
 * Options Trading Module
 *
 * Handles options trading functionality including contract selection,
 * order execution, and exit management.
 *
 * [TOGGLE] Enable with options_enabled in config
 * [TUNE] Delta, DTE, and position size limits in config
 *
 * Options are used for HIGH CONVICTION plays only (confidence >= 0.8).
 * Finds ATM/ITM calls for bullish signals, puts for bearish.
 * Wider stop-loss (50%) and higher take-profit (100%) than stocks.
 */

import type { HarnessContext } from "./context";
import type { Position } from "../../providers/types";
import { createAlpacaProviders } from "../../providers/alpaca";

/**
 * Check if options trading is enabled in config
 */
export function isOptionsEnabled(ctx: HarnessContext): boolean {
  return ctx.state.config.options_enabled === true;
}

/**
 * Find the best options contract for a given symbol and direction
 *
 * Searches the options chain for contracts matching configured criteria:
 * - DTE within min/max range
 * - Delta within min/max range
 * - Reasonable bid/ask spread (<10%)
 * - Affordable based on equity and position size limits
 */
export async function findBestOptionsContract(
  ctx: HarnessContext,
  symbol: string,
  direction: "bullish" | "bearish",
  equity: number
): Promise<{
  symbol: string;
  strike: number;
  expiration: string;
  delta: number;
  mid_price: number;
  max_contracts: number;
} | null> {
  if (!isOptionsEnabled(ctx)) return null;

  try {
    const alpaca = createAlpacaProviders(ctx.env);
    const expirations = await alpaca.options.getExpirations(symbol);

    if (!expirations || expirations.length === 0) {
      ctx.log("Options", "no_expirations", { symbol });
      return null;
    }

    const today = new Date();
    const validExpirations = expirations.filter(exp => {
      const expDate = new Date(exp);
      const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return dte >= ctx.state.config.options_min_dte && dte <= ctx.state.config.options_max_dte;
    });

    if (validExpirations.length === 0) {
      ctx.log("Options", "no_valid_expirations", { symbol });
      return null;
    }

    const targetDTE = (ctx.state.config.options_min_dte + ctx.state.config.options_max_dte) / 2;
    const bestExpiration = validExpirations.reduce((best: string, exp: string) => {
      const expDate = new Date(exp);
      const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const currentBestDte = Math.ceil((new Date(best).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return Math.abs(dte - targetDTE) < Math.abs(currentBestDte - targetDTE) ? exp : best;
    }, validExpirations[0]!);

    const chain = await alpaca.options.getChain(symbol, bestExpiration);
    if (!chain) {
      ctx.log("Options", "chain_failed", { symbol, expiration: bestExpiration });
      return null;
    }

    const contracts = direction === "bullish" ? chain.calls : chain.puts;
    if (!contracts || contracts.length === 0) {
      ctx.log("Options", "no_contracts", { symbol, direction });
      return null;
    }

    const snapshot = await alpaca.marketData.getSnapshot(symbol).catch(() => null);
    const stockPrice = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
    if (stockPrice === 0) return null;

    const targetStrike = direction === "bullish"
      ? stockPrice * (1 - (ctx.state.config.options_target_delta - 0.5) * 0.2)
      : stockPrice * (1 + (ctx.state.config.options_target_delta - 0.5) * 0.2);

    const sortedContracts = contracts
      .filter(c => c.strike > 0)
      .sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));

    for (const contract of sortedContracts.slice(0, 5)) {
      const contractSnapshot = await alpaca.options.getSnapshot(contract.symbol);
      if (!contractSnapshot) continue;

      const delta = contractSnapshot.greeks?.delta;
      const absDelta = delta !== undefined ? Math.abs(delta) : null;

      if (absDelta === null || absDelta < ctx.state.config.options_min_delta || absDelta > ctx.state.config.options_max_delta) {
        continue;
      }

      const bid = contractSnapshot.latest_quote?.bid_price || 0;
      const ask = contractSnapshot.latest_quote?.ask_price || 0;
      if (bid === 0 || ask === 0) continue;

      const spread = (ask - bid) / ask;
      if (spread > 0.10) continue;

      const midPrice = (bid + ask) / 2;
      const maxCost = equity * ctx.state.config.options_max_pct_per_trade;
      const maxContracts = Math.floor(maxCost / (midPrice * 100));

      if (maxContracts < 1) continue;

      ctx.log("Options", "contract_selected", {
        symbol,
        contract: contract.symbol,
        strike: contract.strike,
        expiration: bestExpiration,
        delta: delta?.toFixed(3),
        mid_price: midPrice.toFixed(2),
      });

      return {
        symbol: contract.symbol,
        strike: contract.strike,
        expiration: bestExpiration,
        delta: delta!,
        mid_price: midPrice,
        max_contracts: maxContracts,
      };
    }

    return null;
  } catch (error) {
    ctx.log("Options", "error", { symbol, message: String(error) });
    return null;
  }
}

/**
 * Execute an options buy order
 *
 * Places a limit order for the specified contract.
 * Validates position size against configured limits.
 */
export async function executeOptionsOrder(
  ctx: HarnessContext,
  contract: { symbol: string; mid_price: number },
  quantity: number,
  equity: number
): Promise<boolean> {
  if (!isOptionsEnabled(ctx)) return false;

  const totalCost = contract.mid_price * quantity * 100;
  const maxAllowed = equity * ctx.state.config.options_max_pct_per_trade;

  if (totalCost > maxAllowed) {
    quantity = Math.floor(maxAllowed / (contract.mid_price * 100));
    if (quantity < 1) {
      ctx.log("Options", "skipped_size", { contract: contract.symbol, cost: totalCost, max: maxAllowed });
      return false;
    }
  }

  try {
    const alpaca = createAlpacaProviders(ctx.env);
    const order = await alpaca.trading.createOrder({
      symbol: contract.symbol,
      qty: quantity,
      side: "buy",
      type: "limit",
      limit_price: Math.round(contract.mid_price * 100) / 100,
      time_in_force: "day",
    });

    ctx.log("Options", "options_buy_executed", {
      contract: contract.symbol,
      qty: quantity,
      status: order.status,
      estimated_cost: (contract.mid_price * quantity * 100).toFixed(2),
    });

    return true;
  } catch (error) {
    ctx.log("Options", "options_buy_failed", { contract: contract.symbol, error: String(error) });
    return false;
  }
}

/**
 * Check options positions for exit signals
 *
 * Evaluates all options positions against stop-loss and take-profit thresholds.
 * Returns list of positions that should be closed.
 */
export async function checkOptionsExits(
  ctx: HarnessContext,
  positions: Position[]
): Promise<Array<{
  symbol: string;
  reason: string;
  type: string;
  pnl_pct: number;
}>> {
  if (!isOptionsEnabled(ctx)) return [];

  const exits: Array<{ symbol: string; reason: string; type: string; pnl_pct: number }> = [];
  const optionsPositions = positions.filter(p => p.asset_class === "us_option");

  for (const pos of optionsPositions) {
    const entryPrice = pos.avg_entry_price || pos.current_price;
    const plPct = entryPrice > 0 ? ((pos.current_price - entryPrice) / entryPrice) * 100 : 0;

    if (plPct <= -ctx.state.config.options_stop_loss_pct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Options stop loss at ${plPct.toFixed(1)}%`,
        type: "stop_loss",
        pnl_pct: plPct,
      });
      continue;
    }

    if (plPct >= ctx.state.config.options_take_profit_pct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Options take profit at +${plPct.toFixed(1)}%`,
        type: "take_profit",
        pnl_pct: plPct,
      });
      continue;
    }
  }

  return exits;
}
