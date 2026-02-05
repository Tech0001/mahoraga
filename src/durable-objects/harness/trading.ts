/**
 * Trading Execution Module
 *
 * Handles core trading operations including the main analyst loop,
 * buy/sell execution, and crypto trading.
 */

import type { HarnessContext } from "./context";
import type { ResearchResult } from "./types";
import type { Account, Position } from "../../providers/types";
import { createAlpacaProviders } from "../../providers/alpaca";
import { isCryptoSymbol, normalizeCryptoSymbol } from "./utils";
import {
  analyzeSignalsWithLLM,
  trackLLMCost,
} from "./llm-research";
import {
  isTwitterEnabled,
  gatherTwitterConfirmation,
} from "./twitter";
import { sendTradeAlert } from "./notifications";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

type AlpacaProviders = ReturnType<typeof createAlpacaProviders>;

interface StalenessResult {
  isStale: boolean;
  reason: string;
  staleness_score: number;
}

// ============================================================================
// CRISIS MODE HELPERS
// ============================================================================

/**
 * Check if crisis mode is blocking new entries
 */
function isCrisisBlockingEntries(ctx: HarnessContext): boolean {
  if (!ctx.state.config.crisis_mode_enabled) return false;
  if (ctx.state.crisisState.manualOverride) return false;

  // Level 2+ blocks new entries
  return ctx.state.crisisState.level >= 2;
}

/**
 * Get position size multiplier based on crisis level
 */
function getCrisisPositionMultiplier(ctx: HarnessContext): number {
  if (!ctx.state.config.crisis_mode_enabled) return 1.0;
  if (ctx.state.crisisState.manualOverride) return 1.0;

  const level = ctx.state.crisisState.level;
  switch (level) {
    case 0: return 1.0;       // Normal - full size
    case 1: return 0.5;       // Elevated - half size
    case 2: return 0.0;       // High alert - no new positions
    case 3: return 0.0;       // Full crisis - no new positions
    default: return 1.0;
  }
}

// ============================================================================
// STALENESS DETECTION
// ============================================================================

/**
 * Analyze position staleness based on hold time, price action, and social volume
 */
function analyzeStaleness(
  ctx: HarnessContext,
  symbol: string,
  currentPrice: number,
  currentSocialVolume: number
): StalenessResult {
  const entry = ctx.state.positionEntries[symbol];
  if (!entry) {
    return { isStale: false, reason: "No entry data", staleness_score: 0 };
  }

  const holdHours = (Date.now() - entry.entry_time) / (1000 * 60 * 60);
  const holdDays = holdHours / 24;
  const pnlPct = entry.entry_price > 0
    ? ((currentPrice - entry.entry_price) / entry.entry_price) * 100
    : 0;

  if (holdHours < ctx.state.config.stale_min_hold_hours) {
    return { isStale: false, reason: `Too early (${holdHours.toFixed(1)}h)`, staleness_score: 0 };
  }

  let stalenessScore = 0;

  // Time-based (max 40 points)
  if (holdDays >= ctx.state.config.stale_max_hold_days) {
    stalenessScore += 40;
  } else if (holdDays >= ctx.state.config.stale_mid_hold_days) {
    stalenessScore += 20 * (holdDays - ctx.state.config.stale_mid_hold_days) /
      (ctx.state.config.stale_max_hold_days - ctx.state.config.stale_mid_hold_days);
  }

  // Price action (max 30 points)
  if (pnlPct < 0) {
    stalenessScore += Math.min(30, Math.abs(pnlPct) * 3);
  } else if (pnlPct < ctx.state.config.stale_mid_min_gain_pct && holdDays >= ctx.state.config.stale_mid_hold_days) {
    stalenessScore += 15;
  }

  // Social volume decay (max 30 points)
  const volumeRatio = entry.entry_social_volume > 0
    ? currentSocialVolume / entry.entry_social_volume
    : 1;
  if (volumeRatio <= ctx.state.config.stale_social_volume_decay) {
    stalenessScore += 30;
  } else if (volumeRatio <= 0.5) {
    stalenessScore += 15;
  }

  stalenessScore = Math.min(100, stalenessScore);

  const isStale = stalenessScore >= 70 ||
    (holdDays >= ctx.state.config.stale_max_hold_days && pnlPct < ctx.state.config.stale_min_gain_pct);

  return {
    isStale,
    reason: isStale
      ? `Staleness score ${stalenessScore}/100, held ${holdDays.toFixed(1)} days`
      : `OK (score ${stalenessScore}/100)`,
    staleness_score: stalenessScore,
  };
}

// ============================================================================
// STOCK TRADING EXECUTION
// ============================================================================

/**
 * Execute a stock buy order
 */
export async function executeBuy(
  ctx: HarnessContext,
  alpaca: AlpacaProviders,
  symbol: string,
  confidence: number,
  account: Account
): Promise<boolean> {
  // Crisis mode check - block new entries during high alert
  if (isCrisisBlockingEntries(ctx)) {
    ctx.log("Executor", "buy_blocked", {
      symbol,
      reason: "CRISIS_MODE_BLOCKING",
      crisisLevel: ctx.state.crisisState.level,
      triggered: ctx.state.crisisState.triggeredIndicators,
    });
    return false;
  }

  if (!symbol || symbol.trim().length === 0) {
    ctx.log("Executor", "buy_blocked", { reason: "INVARIANT: Empty symbol" });
    return false;
  }

  if (account.cash <= 0) {
    ctx.log("Executor", "buy_blocked", { symbol, reason: "INVARIANT: No cash available", cash: account.cash });
    return false;
  }

  if (confidence <= 0 || confidence > 1 || !Number.isFinite(confidence)) {
    ctx.log("Executor", "buy_blocked", { symbol, reason: "INVARIANT: Invalid confidence", confidence });
    return false;
  }

  const sizePct = Math.min(20, ctx.state.config.position_size_pct_of_cash);
  const crisisMultiplier = getCrisisPositionMultiplier(ctx);
  const positionSize = Math.min(
    account.cash * (sizePct / 100) * confidence * crisisMultiplier,
    ctx.state.config.max_position_value * crisisMultiplier
  );

  if (crisisMultiplier < 1.0) {
    ctx.log("Executor", "crisis_size_reduction", {
      symbol,
      crisisLevel: ctx.state.crisisState.level,
      multiplier: crisisMultiplier,
    });
  }

  if (positionSize < 10) {
    ctx.log("Executor", "buy_skipped", { symbol, reason: "Position too small" });
    return false;
  }

  const maxAllowed = ctx.state.config.max_position_value * 1.01;
  if (positionSize <= 0 || positionSize > maxAllowed || !Number.isFinite(positionSize)) {
    ctx.log("Executor", "buy_blocked", {
      symbol,
      reason: "INVARIANT: Invalid position size",
      positionSize,
      maxAllowed,
    });
    return false;
  }

  try {
    const isCrypto = isCryptoSymbol(symbol, ctx.state.config.crypto_symbols || []);
    const orderSymbol = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;
    const timeInForce = isCrypto ? "gtc" : "day";

    if (!isCrypto) {
      const allowedExchanges = ctx.state.config.allowed_exchanges ?? ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"];
      if (allowedExchanges.length > 0) {
        const asset = await alpaca.trading.getAsset(symbol);
        if (!asset) {
          ctx.log("Executor", "buy_blocked", { symbol, reason: "Asset not found" });
          return false;
        }
        if (!allowedExchanges.includes(asset.exchange)) {
          ctx.log("Executor", "buy_blocked", {
            symbol,
            reason: "Exchange not allowed (OTC/foreign stocks have data issues)",
            exchange: asset.exchange,
            allowedExchanges
          });
          return false;
        }
      }
    }

    const order = await alpaca.trading.createOrder({
      symbol: orderSymbol,
      notional: Math.round(positionSize * 100) / 100,
      side: "buy",
      type: "market",
      time_in_force: timeInForce,
    });

    ctx.log("Executor", "buy_executed", { symbol: orderSymbol, isCrypto, status: order.status, size: positionSize });

    // Send Telegram notification for stock/crypto entry
    sendTradeAlert(ctx, "entry", {
      symbol: orderSymbol,
      side: "BUY",
      reason: `Confidence ${(confidence * 100).toFixed(0)}%`,
      market: isCrypto ? "crypto" : "stock",
      details: {
        "Size": "$" + positionSize.toFixed(2),
      },
    });

    return true;
  } catch (error) {
    ctx.log("Executor", "buy_failed", { symbol, error: String(error) });
    return false;
  }
}

/**
 * Execute a stock sell (close position)
 */
export async function executeSell(
  ctx: HarnessContext,
  alpaca: AlpacaProviders,
  symbol: string,
  reason: string
): Promise<boolean> {
  if (!symbol || symbol.trim().length === 0) {
    ctx.log("Executor", "sell_blocked", { reason: "INVARIANT: Empty symbol" });
    return false;
  }

  if (!reason || reason.trim().length === 0) {
    ctx.log("Executor", "sell_blocked", { symbol, reason: "INVARIANT: No sell reason provided" });
    return false;
  }

  // PDT Protection: Check if this would be a day trade on an account under $25k
  const isCrypto = isCryptoSymbol(symbol, ctx.state.config.crypto_symbols || []);
  if (!isCrypto) {
    const entry = ctx.state.positionEntries[symbol];
    if (entry) {
      const entryDate = new Date(entry.entry_time).toDateString();
      const today = new Date().toDateString();
      const isSameDaySell = entryDate === today;

      if (isSameDaySell) {
        try {
          const account = await alpaca.trading.getAccount();
          const PDT_EQUITY_THRESHOLD = 25000;
          const PDT_TRADE_LIMIT = 3;

          if (account.equity < PDT_EQUITY_THRESHOLD && account.daytrade_count >= PDT_TRADE_LIMIT) {
            ctx.log("Executor", "sell_blocked_pdt", {
              symbol,
              reason: "PDT protection: Would exceed day trade limit",
              equity: account.equity,
              daytrade_count: account.daytrade_count,
              original_reason: reason,
            });
            return false;
          }

          // Warn if approaching PDT limit
          if (account.equity < PDT_EQUITY_THRESHOLD && account.daytrade_count >= 2) {
            ctx.log("Executor", "pdt_warning", {
              symbol,
              message: `Day trade ${account.daytrade_count + 1}/3 - approaching PDT limit`,
              equity: account.equity,
            });
          }
        } catch (e) {
          // If we can't check account, allow the trade but log warning
          ctx.log("Executor", "pdt_check_failed", { symbol, error: String(e) });
        }
      }
    }
  }

  try {
    await alpaca.trading.closePosition(symbol);
    ctx.log("Executor", "sell_executed", { symbol, reason });

    // Send Telegram notification for stock/crypto exit
    sendTradeAlert(ctx, "exit", {
      symbol,
      side: "SELL",
      reason,
      market: isCrypto ? "crypto" : "stock",
    });

    delete ctx.state.positionEntries[symbol];
    delete ctx.state.socialHistory[symbol];
    delete ctx.state.stalenessAnalysis[symbol];

    return true;
  } catch (error) {
    ctx.log("Executor", "sell_failed", { symbol, error: String(error) });
    return false;
  }
}

// ============================================================================
// MAIN ANALYST LOOP
// ============================================================================

/**
 * Main analyst loop - checks exits, processes signals, and executes trades
 *
 * Note: This function requires additional context for options trading functionality.
 * The options-related callbacks should be passed in if options trading is enabled.
 */
export async function runAnalyst(
  ctx: HarnessContext,
  options?: {
    isOptionsEnabled?: () => boolean;
    findBestOptionsContract?: (symbol: string, direction: "bullish" | "bearish", equity: number) => Promise<unknown>;
    executeOptionsOrder?: (contract: unknown, qty: number, equity: number) => Promise<boolean>;
  }
): Promise<void> {
  const alpaca = createAlpacaProviders(ctx.env);

  const [account, positions, clock] = await Promise.all([
    alpaca.trading.getAccount(),
    alpaca.trading.getPositions(),
    alpaca.trading.getClock(),
  ]);

  if (!account || !clock.is_open) {
    ctx.log("System", "analyst_skipped", { reason: "Account unavailable or market closed" });
    return;
  }

  const heldSymbols = new Set(positions.map(p => p.symbol));

  // Check position exits
  for (const pos of positions) {
    if (pos.asset_class === "us_option") continue;  // Options handled separately

    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

    // Take profit
    if (plPct >= ctx.state.config.take_profit_pct) {
      await executeSell(ctx, alpaca, pos.symbol, `Take profit at +${plPct.toFixed(1)}%`);
      continue;
    }

    // Stop loss
    if (plPct <= -ctx.state.config.stop_loss_pct) {
      await executeSell(ctx, alpaca, pos.symbol, `Stop loss at ${plPct.toFixed(1)}%`);
      continue;
    }

    // Check staleness
    if (ctx.state.config.stale_position_enabled) {
      const stalenessResult = analyzeStaleness(ctx, pos.symbol, pos.current_price, 0);
      ctx.state.stalenessAnalysis[pos.symbol] = stalenessResult;

      if (stalenessResult.isStale) {
        await executeSell(ctx, alpaca, pos.symbol, `STALE: ${stalenessResult.reason}`);
      }
    }
  }

  if (positions.length < ctx.state.config.max_positions && ctx.state.signalCache.length > 0) {
    // Check if symbol is crypto
    const checkIsCrypto = (symbol: string) => isCryptoSymbol(symbol, ctx.state.config.crypto_symbols || []);
    // Default to true if not set (stocks ON by default)
    const stocksEnabled = ctx.state.config.stocks_enabled ?? true;

    const researchedBuys = Object.values(ctx.state.signalResearch)
      .filter((r): r is ResearchResult => r !== null && r.verdict === "BUY" && r.confidence >= ctx.state.config.min_analyst_confidence)
      .filter(r => !heldSymbols.has(r.symbol))
      // Filter out stocks if stocks_enabled is false (crypto-only mode)
      .filter(r => stocksEnabled || checkIsCrypto(r.symbol))
      .sort((a, b) => b.confidence - a.confidence);

    for (const research of researchedBuys.slice(0, 3)) {
      if (positions.length >= ctx.state.config.max_positions) break;
      if (heldSymbols.has(research.symbol)) continue;

      const originalSignal = ctx.state.signalCache.find(s => s.symbol === research.symbol);
      let finalConfidence = research.confidence;

      if (isTwitterEnabled(ctx) && originalSignal) {
        const twitterConfirm = await gatherTwitterConfirmation(ctx, research.symbol, originalSignal.sentiment);
        if (twitterConfirm?.confirms_existing) {
          finalConfidence = Math.min(1.0, finalConfidence * 1.15);
          ctx.log("System", "twitter_boost", { symbol: research.symbol, new_confidence: finalConfidence });
        } else if (twitterConfirm && !twitterConfirm.confirms_existing && twitterConfirm.sentiment !== 0) {
          finalConfidence = finalConfidence * 0.85;
        }
      }

      if (finalConfidence < ctx.state.config.min_analyst_confidence) continue;

      // Options trading (if callbacks provided)
      if (options?.isOptionsEnabled?.() &&
          finalConfidence >= ctx.state.config.options_min_confidence &&
          research.entry_quality === "excellent" &&
          options.findBestOptionsContract &&
          options.executeOptionsOrder) {
        const contract = await options.findBestOptionsContract(research.symbol, "bullish", account.equity);
        if (contract) {
          const optionsResult = await options.executeOptionsOrder(contract, 1, account.equity);
          if (optionsResult) {
            ctx.log("System", "options_position_opened", { symbol: research.symbol });
          }
        }
      }

      const result = await executeBuy(ctx, alpaca, research.symbol, finalConfidence, account);
      if (result) {
        heldSymbols.add(research.symbol);
        ctx.state.positionEntries[research.symbol] = {
          symbol: research.symbol,
          entry_time: Date.now(),
          entry_price: 0,
          entry_sentiment: originalSignal?.sentiment || finalConfidence,
          entry_social_volume: originalSignal?.volume || 0,
          entry_sources: originalSignal?.subreddits || [originalSignal?.source || "research"],
          entry_reason: research.reasoning,
          peak_price: 0,
          peak_sentiment: originalSignal?.sentiment || finalConfidence,
        };
      }
    }

    const analysis = await analyzeSignalsWithLLM(ctx, ctx.state.signalCache, positions, account);
    const researchedSymbols = new Set(researchedBuys.map(r => r.symbol));

    for (const rec of analysis.recommendations) {
      if (rec.confidence < ctx.state.config.min_analyst_confidence) continue;

      if (rec.action === "SELL" && heldSymbols.has(rec.symbol)) {
        const entry = ctx.state.positionEntries[rec.symbol];
        const holdMinutes = entry ? (Date.now() - entry.entry_time) / (1000 * 60) : 0;
        const minHoldMinutes = ctx.state.config.llm_min_hold_minutes ?? 30;

        if (holdMinutes < minHoldMinutes) {
          ctx.log("Analyst", "llm_sell_blocked", {
            symbol: rec.symbol,
            holdMinutes: Math.round(holdMinutes),
            minRequired: minHoldMinutes,
            reason: "Position held less than minimum hold time"
          });
          continue;
        }

        const result = await executeSell(ctx, alpaca, rec.symbol, `LLM recommendation: ${rec.reasoning}`);
        if (result) {
          heldSymbols.delete(rec.symbol);
          ctx.log("Analyst", "llm_sell_executed", { symbol: rec.symbol, confidence: rec.confidence, reasoning: rec.reasoning });
        }
        continue;
      }

      if (rec.action === "BUY") {
        if (positions.length >= ctx.state.config.max_positions) continue;
        if (heldSymbols.has(rec.symbol)) continue;
        if (researchedSymbols.has(rec.symbol)) continue;

        const result = await executeBuy(ctx, alpaca, rec.symbol, rec.confidence, account);
        if (result) {
          const originalSignal = ctx.state.signalCache.find(s => s.symbol === rec.symbol);
          heldSymbols.add(rec.symbol);
          ctx.state.positionEntries[rec.symbol] = {
            symbol: rec.symbol,
            entry_time: Date.now(),
            entry_price: 0,
            entry_sentiment: originalSignal?.sentiment || rec.confidence,
            entry_social_volume: originalSignal?.volume || 0,
            entry_sources: originalSignal?.subreddits || [originalSignal?.source || "analyst"],
            entry_reason: rec.reasoning,
            peak_price: 0,
            peak_sentiment: originalSignal?.sentiment || rec.confidence,
          };
        }
      }
    }
  }
}

// ============================================================================
// CRYPTO TRADING
// ============================================================================

/**
 * Research a cryptocurrency using LLM
 */
export async function researchCrypto(
  ctx: HarnessContext,
  symbol: string,
  momentum: number,
  sentiment: number
): Promise<ResearchResult | null> {
  if (!ctx.llm) {
    ctx.log("Crypto", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
    return null;
  }

  try {
    const alpaca = createAlpacaProviders(ctx.env);
    const snapshot = await alpaca.marketData.getCryptoSnapshot(symbol).catch(() => null);
    const price = snapshot?.latest_trade?.price || 0;
    const dailyChange = snapshot ? ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100 : 0;

    const prompt = `Should we BUY this cryptocurrency based on momentum and market conditions?

SYMBOL: ${symbol}
PRICE: $${price.toFixed(2)}
24H CHANGE: ${dailyChange.toFixed(2)}%
MOMENTUM SCORE: ${(momentum * 100).toFixed(0)}%
SENTIMENT: ${(sentiment * 100).toFixed(0)}% bullish

Evaluate if this is a good entry. Consider:
- Is the momentum sustainable or a trap?
- Any major news/events affecting this crypto?
- Risk/reward at current price level?

JSON response:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "entry_quality": "excellent|good|fair|poor",
  "reasoning": "brief reason",
  "red_flags": ["any concerns"],
  "catalysts": ["positive factors"]
}`;

    const response = await ctx.llm.complete({
      model: ctx.state.config.llm_model, // Use config model (usually cheap one)
      messages: [
        { role: "system", content: "You are a crypto analyst. Be skeptical of FOMO. Crypto is volatile - only recommend BUY for strong setups. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      max_tokens: 250,
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const usage = response.usage;
    if (usage) {
      trackLLMCost(ctx, ctx.state.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
    }

    const content = response.content || "{}";
    const analysis = JSON.parse(content.replace(/```json\n?|```/g, "").trim()) as {
      verdict: "BUY" | "SKIP" | "WAIT";
      confidence: number;
      entry_quality: "excellent" | "good" | "fair" | "poor";
      reasoning: string;
      red_flags: string[];
      catalysts: string[];
    };

    const result: ResearchResult = {
      symbol,
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      entry_quality: analysis.entry_quality,
      reasoning: analysis.reasoning,
      red_flags: analysis.red_flags || [],
      catalysts: analysis.catalysts || [],
      timestamp: Date.now(),
    };

    ctx.state.signalResearch[symbol] = result;
    ctx.log("Crypto", "researched", {
      symbol,
      verdict: result.verdict,
      confidence: result.confidence,
      quality: result.entry_quality,
    });

    return result;
  } catch (error) {
    ctx.log("Crypto", "research_error", { symbol, error: String(error) });
    return null;
  }
}

/**
 * Execute a crypto buy order
 */
export async function executeCryptoBuy(
  ctx: HarnessContext,
  alpaca: AlpacaProviders,
  symbol: string,
  confidence: number,
  account: Account
): Promise<boolean> {
  const sizePct = Math.min(20, ctx.state.config.position_size_pct_of_cash);
  const positionSize = Math.min(
    account.cash * (sizePct / 100) * confidence,
    ctx.state.config.crypto_max_position_value
  );

  if (positionSize < 10) {
    ctx.log("Crypto", "buy_skipped", { symbol, reason: "Position too small" });
    return false;
  }

  try {
    const order = await alpaca.trading.createOrder({
      symbol,
      notional: Math.round(positionSize * 100) / 100,
      side: "buy",
      type: "market",
      time_in_force: "gtc",
    });

    ctx.log("Crypto", "buy_executed", { symbol, status: order.status, size: positionSize });

    // Send Telegram notification for crypto entry
    sendTradeAlert(ctx, "entry", {
      symbol,
      side: "BUY",
      reason: `Confidence ${(confidence * 100).toFixed(0)}%`,
      market: "crypto",
      details: {
        "Size": "$" + positionSize.toFixed(2),
      },
    });

    return true;
  } catch (error) {
    ctx.log("Crypto", "buy_failed", { symbol, error: String(error) });
    return false;
  }
}

/**
 * Run crypto trading logic
 * Manages crypto positions: checks exits (take profit/stop loss) and entries
 */
export async function runCryptoTrading(
  ctx: HarnessContext,
  alpaca: AlpacaProviders,
  positions: Position[]
): Promise<void> {
  if (!ctx.state.config.crypto_enabled) return;

  const cryptoSymbols = new Set(ctx.state.config.crypto_symbols || []);
  const cryptoPositions = positions.filter(p => cryptoSymbols.has(p.symbol) || p.symbol.includes("/"));
  const heldCrypto = new Set(cryptoPositions.map(p => p.symbol));

  for (const pos of cryptoPositions) {
    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

    if (plPct >= ctx.state.config.crypto_take_profit_pct) {
      ctx.log("Crypto", "take_profit", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
      await executeSell(ctx, alpaca, pos.symbol, `Crypto take profit at +${plPct.toFixed(1)}%`);
      continue;
    }

    if (plPct <= -ctx.state.config.crypto_stop_loss_pct) {
      ctx.log("Crypto", "stop_loss", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
      await executeSell(ctx, alpaca, pos.symbol, `Crypto stop loss at ${plPct.toFixed(1)}%`);
      continue;
    }
  }

  const maxCryptoPositions = Math.min(ctx.state.config.crypto_symbols?.length || 3, 3);
  if (cryptoPositions.length >= maxCryptoPositions) return;

  const cryptoSignals = ctx.state.signalCache
    .filter(s => s.isCrypto)
    .filter(s => !heldCrypto.has(s.symbol))
    .filter(s => s.sentiment > 0)
    .sort((a, b) => (b.momentum || 0) - (a.momentum || 0));

  for (const signal of cryptoSignals.slice(0, 2)) {
    if (cryptoPositions.length >= maxCryptoPositions) break;

    const existingResearch = ctx.state.signalResearch[signal.symbol];
    const CRYPTO_RESEARCH_TTL_MS = 300_000;

    let research: ResearchResult | null = existingResearch ?? null;
    if (!existingResearch || Date.now() - existingResearch.timestamp > CRYPTO_RESEARCH_TTL_MS) {
      research = await researchCrypto(ctx, signal.symbol, signal.momentum || 0, signal.sentiment);
    }

    if (!research || research.verdict !== "BUY") {
      ctx.log("Crypto", "research_skip", {
        symbol: signal.symbol,
        verdict: research?.verdict || "NO_RESEARCH",
        confidence: research?.confidence || 0
      });
      continue;
    }

    if (research.confidence < ctx.state.config.min_analyst_confidence) {
      ctx.log("Crypto", "low_confidence", { symbol: signal.symbol, confidence: research.confidence });
      continue;
    }

    const account = await alpaca.trading.getAccount();
    const result = await executeCryptoBuy(ctx, alpaca, signal.symbol, research.confidence, account);

    if (result) {
      heldCrypto.add(signal.symbol);
      cryptoPositions.push({ symbol: signal.symbol } as Position);
      break;
    }
  }
}
