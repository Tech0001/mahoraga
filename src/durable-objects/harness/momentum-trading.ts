/**
 * Momentum Lane Execution (stocks, Alpaca paper)
 *
 * Consumes the momo watchlist + chart-structure reads and executes the
 * pre-planned trades: entry only when a fresh trigger breaks on an
 * actionable setup, exits driven primarily by structure (descending wedge,
 * VWAP lost, breakdown) with hard stop / 2R target / time-exit / EOD-flatten
 * as rails. Every trade carries an entry-moment snapshot so per-lane
 * expectancy is computable exactly like the DEX table.
 *
 * SHIPS DISABLED (momentum_trading_enabled=false): the lane arms only when
 * the Director flips it after calibrating setup labels against real charts.
 */

import type { HarnessContext } from "./context";
import type { createAlpacaProviders } from "../../providers/alpaca";
import { structuralExitSignal } from "./chart-structure";

type AlpacaProviders = ReturnType<typeof createAlpacaProviders>;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDay(ctx: HarnessContext): { day: string; realizedUsd: number } {
  if (!ctx.state.momentumDay || ctx.state.momentumDay.day !== today()) {
    ctx.state.momentumDay = { day: today(), realizedUsd: 0 };
  }
  return ctx.state.momentumDay;
}

export async function runMomentumTrading(
  ctx: HarnessContext,
  alpaca: AlpacaProviders,
  minutesToClose: number
): Promise<void> {
  ensureDay(ctx);
  await checkExits(ctx, alpaca, minutesToClose);
  if (ctx.state.config.momentum_trading_enabled) {
    await checkEntries(ctx, alpaca, minutesToClose);
  }
}

async function checkEntries(ctx: HarnessContext, alpaca: AlpacaProviders, minutesToClose: number): Promise<void> {
  const cfg = ctx.state.config;
  const day = ensureDay(ctx);
  const positions = ctx.state.momentumPositions;

  // Rails: daily loss cap halts the lane for the day; no fresh entries into
  // the close (nothing new with under 30 minutes left).
  if (day.realizedUsd <= -(cfg.momentum_daily_loss_cap_usd ?? 150)) return;
  if (minutesToClose < 30) return;
  if (Object.keys(positions).length >= (cfg.momentum_max_positions ?? 3)) return;

  // News scalp (Director's second play): A-grade catalyst with a big gap —
  // buy the open, sell into the rush seconds later, out before the dip.
  // Paper fills flatter this pattern; its stats carry a discount until live.
  const minutesSinceOpen = 390 - minutesToClose;
  if (
    (cfg.momentum_news_scalp_enabled ?? true) &&
    minutesSinceOpen >= 0 &&
    minutesSinceOpen <= 1.5
  ) {
    for (const cand of ctx.state.momoWatchlist) {
      if (Object.keys(positions).length >= (cfg.momentum_max_positions ?? 3)) break;
      if (positions[cand.symbol]) continue;
      const cat = ctx.state.momoCatalysts?.[cand.symbol];
      if (!cat || cat.grade !== "A" || cat.dilutionRisk) continue;
      if (cand.changePct < (cfg.momentum_news_scalp_min_gap_pct ?? 10)) continue;
      const qty = Math.floor((cfg.momentum_position_usd ?? 500) / cand.price);
      if (qty < 1) continue;
      try {
        const order = await alpaca.trading.createOrder({
          symbol: cand.symbol,
          qty,
          side: "buy",
          type: "market",
          time_in_force: "day",
        });
        positions[cand.symbol] = {
          symbol: cand.symbol,
          qty,
          entryPrice: cand.price,
          entryTime: Date.now(),
          plannedStop: cand.price * 0.96,
          targetPrice: cand.price * 1.1,
          setupAtEntry: "NEWS_SCALP",
          orderId: order?.id,
          scalpUntil: Date.now() + (cfg.momentum_news_scalp_hold_seconds ?? 15) * 1000,
          entrySnapshot: {
            score: cand.score,
            rvol: cand.rvol,
            changePct: cand.changePct,
            distFromVwapPct: 0,
            blueSky: null,
            note: `A-catalyst open scalp: ${cat.catalyst}`,
          },
        };
        ctx.log("Momentum", "momentum_entry", {
          symbol: cand.symbol,
          setup: "NEWS_SCALP",
          qty,
          price: cand.price.toFixed(2),
          catalyst: cat.catalyst,
          holdSeconds: cfg.momentum_news_scalp_hold_seconds ?? 15,
        });
      } catch (e) {
        ctx.log("Momentum", "momentum_entry_error", { symbol: cand.symbol, error: String(e).slice(0, 140) });
      }
    }
  }

  const actionable = new Set(["ORB", "OPEN_RECLAIM", "FLAG", "VWAP_HOLD"]);
  for (const cand of ctx.state.momoWatchlist) {
    if (Object.keys(positions).length >= (cfg.momentum_max_positions ?? 3)) break;
    if (positions[cand.symbol]) continue;
    const read = ctx.state.momoCharts[cand.symbol];
    if (!read || !actionable.has(read.setup) || read.trigger === null || read.stop === null) continue;

    // Fresh break only: at/just through the trigger, not chasing an extended move.
    const price = cand.price;
    if (price < read.trigger || price > read.trigger * 1.015) continue;

    const qty = Math.floor((cfg.momentum_position_usd ?? 500) / price);
    if (qty < 1) continue;

    try {
      const order = await alpaca.trading.createOrder({
        symbol: cand.symbol,
        qty,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });
      const rMultiple = cfg.momentum_take_profit_r ?? 2;
      positions[cand.symbol] = {
        symbol: cand.symbol,
        qty,
        entryPrice: price,
        entryTime: Date.now(),
        plannedStop: read.stop,
        targetPrice: read.trigger + rMultiple * (read.trigger - read.stop),
        setupAtEntry: read.setup,
        orderId: order?.id,
        entrySnapshot: {
          score: cand.score,
          rvol: cand.rvol,
          changePct: cand.changePct,
          distFromVwapPct: read.distFromVwapPct,
          blueSky: read.blueSky,
          note: read.note,
        },
      };
      ctx.log("Momentum", "momentum_entry", {
        symbol: cand.symbol,
        setup: read.setup,
        qty,
        price: price.toFixed(2),
        trigger: read.trigger.toFixed(2),
        stop: read.stop.toFixed(2),
        target: positions[cand.symbol]!.targetPrice.toFixed(2),
        rvol: cand.rvol.toFixed(1),
        blueSky: read.blueSky,
      });
    } catch (e) {
      ctx.log("Momentum", "momentum_entry_error", { symbol: cand.symbol, error: String(e).slice(0, 140) });
    }
  }
}

async function checkExits(ctx: HarnessContext, alpaca: AlpacaProviders, minutesToClose: number): Promise<void> {
  const positions = ctx.state.momentumPositions;
  const cfg = ctx.state.config;

  for (const pos of Object.values(positions)) {
    let price: number;
    try {
      const bar = await alpaca.marketData.getLatestBar(pos.symbol);
      price = bar.c;
    } catch {
      continue; // no price this cycle — try again next
    }

    let reason: string | null = null;
    if (pos.scalpUntil && Date.now() >= pos.scalpUntil) reason = "news_scalp_exit";
    else if (minutesToClose <= 5) reason = "eod_flatten";
    else if (price <= pos.plannedStop) reason = "hard_stop";
    else if (price >= pos.targetPrice) reason = "target_hit";
    else if ((Date.now() - pos.entryTime) / 60_000 >= (cfg.momentum_time_exit_minutes ?? 45)) reason = "time_exit";
    else {
      const read = ctx.state.momoCharts[pos.symbol];
      if (read) reason = structuralExitSignal(read, pos.entryPrice, price);
    }
    if (!reason) continue;

    try {
      await alpaca.trading.createOrder({
        symbol: pos.symbol,
        qty: pos.qty,
        side: "sell",
        type: "market",
        time_in_force: "day",
      });
      const pnlUsd = (price - pos.entryPrice) * pos.qty;
      const pnlPct = pos.entryPrice > 0 ? ((price - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      ctx.state.momentumTrades.push({
        ...pos,
        exitPrice: price,
        exitTime: Date.now(),
        exitReason: reason,
        pnlUsd,
        pnlPct,
      });
      if (ctx.state.momentumTrades.length > 200) {
        ctx.state.momentumTrades = ctx.state.momentumTrades.slice(-200);
      }
      ensureDay(ctx).realizedUsd += pnlUsd;
      delete positions[pos.symbol];
      ctx.log("Momentum", "momentum_exit", {
        symbol: pos.symbol,
        reason,
        entry: pos.entryPrice.toFixed(2),
        exit: price.toFixed(2),
        pnlUsd: pnlUsd.toFixed(2),
        pnlPct: pnlPct.toFixed(1) + "%",
        heldMin: Math.round((Date.now() - pos.entryTime) / 60_000),
        dayRealized: ensureDay(ctx).realizedUsd.toFixed(2),
      });
    } catch (e) {
      ctx.log("Momentum", "momentum_exit_error", { symbol: pos.symbol, error: String(e).slice(0, 140) });
    }
  }
}
