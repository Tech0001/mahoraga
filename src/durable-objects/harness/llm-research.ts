/**
 * LLM Research Module
 *
 * Handles AI-powered signal research and analysis using configured LLM provider.
 * Contains all LLM prompt engineering for trading decisions.
 */

import type { HarnessContext } from "./context";
import type { Signal, ResearchResult } from "./types";
import type { Account, Position } from "../../providers/types";
import { createAlpacaProviders } from "../../providers/alpaca";
import { isCryptoSymbol, normalizeCryptoSymbol } from "./utils";

// ============================================================================
// LLM COST TRACKING
// ============================================================================

/**
 * Track LLM API costs for monitoring usage
 */
export function trackLLMCost(
  ctx: HarnessContext,
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  };

  const rates = pricing[model] ?? pricing["gpt-4o"]!;
  const cost = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;

  ctx.state.costTracker.total_usd += cost;
  ctx.state.costTracker.calls++;
  ctx.state.costTracker.tokens_in += tokensIn;
  ctx.state.costTracker.tokens_out += tokensOut;

  return cost;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SIGNAL RESEARCH FUNCTIONS
// ============================================================================

/**
 * Research a single signal with LLM
 * Evaluates if a symbol is a good entry based on sentiment and fundamentals
 */
export async function researchSignal(
  ctx: HarnessContext,
  symbol: string,
  sentimentScore: number,
  sources: string[]
): Promise<ResearchResult | null> {
  if (!ctx.llm) {
    ctx.log("SignalResearch", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
    return null;
  }

  const cached = ctx.state.signalResearch[symbol];
  const CACHE_TTL_MS = 180_000;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const alpaca = createAlpacaProviders(ctx.env);
    const isCrypto = isCryptoSymbol(symbol, ctx.state.config.crypto_symbols || []);
    let price = 0;
    if (isCrypto) {
      const normalized = normalizeCryptoSymbol(symbol);
      const snapshot = await alpaca.marketData.getCryptoSnapshot(normalized).catch(() => null);
      price = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
    } else {
      const snapshot = await alpaca.marketData.getSnapshot(symbol).catch(() => null);
      price = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
    }

    const prompt = `Should we BUY this ${isCrypto ? "crypto" : "stock"} based on social sentiment and fundamentals?

SYMBOL: ${symbol}
SENTIMENT: ${(sentimentScore * 100).toFixed(0)}% bullish (sources: ${sources.join(", ")})

CURRENT DATA:
- Price: $${price}

Evaluate if this is a good entry. Consider: Is the sentiment justified? Is it too late (already pumped)? Any red flags?

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
      model: ctx.state.config.llm_model,
      messages: [
        { role: "system", content: "You are a stock research analyst. Be skeptical of hype. Output valid JSON only." },
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
    ctx.log("SignalResearch", "signal_researched", {
      symbol,
      verdict: result.verdict,
      confidence: result.confidence,
      quality: result.entry_quality,
    });

    return result;
  } catch (error) {
    ctx.log("SignalResearch", "error", { symbol, message: String(error) });
    return null;
  }
}

/**
 * Research top N signals from the signal cache
 * Filters out held positions and aggregates by symbol
 */
export async function researchTopSignals(
  ctx: HarnessContext,
  limit = 5
): Promise<ResearchResult[]> {
  const alpaca = createAlpacaProviders(ctx.env);
  const positions = await alpaca.trading.getPositions();
  const heldSymbols = new Set(positions.map(p => p.symbol));

  const allSignals = ctx.state.signalCache;
  const notHeld = allSignals.filter(s => !heldSymbols.has(s.symbol));
  // Use raw_sentiment for threshold (before weighting), weighted sentiment for sorting
  const aboveThreshold = notHeld.filter(s => s.raw_sentiment >= ctx.state.config.min_sentiment_score);
  // Filter out stocks if stocks_enabled is false (crypto-only mode)
  // Default to true if not set (stocks ON by default)
  const stocksEnabled = ctx.state.config.stocks_enabled ?? true;
  const tradeable = aboveThreshold.filter(s => stocksEnabled || s.isCrypto);
  const candidates = tradeable
    .sort((a, b) => b.sentiment - a.sentiment)
    .slice(0, limit);

  if (candidates.length === 0) {
    ctx.log("SignalResearch", "no_candidates", {
      total_signals: allSignals.length,
      not_held: notHeld.length,
      above_threshold: aboveThreshold.length,
      tradeable: tradeable.length,
      stocks_enabled: ctx.state.config.stocks_enabled,
      min_sentiment: ctx.state.config.min_sentiment_score,
    });
    return [];
  }

  ctx.log("SignalResearch", "researching_signals", { count: candidates.length });

  const aggregated = new Map<string, { symbol: string; sentiment: number; sources: string[] }>();
  for (const sig of candidates) {
    if (!aggregated.has(sig.symbol)) {
      aggregated.set(sig.symbol, { symbol: sig.symbol, sentiment: sig.sentiment, sources: [sig.source] });
    } else {
      aggregated.get(sig.symbol)!.sources.push(sig.source);
    }
  }

  const results: ResearchResult[] = [];
  for (const [symbol, data] of aggregated) {
    const analysis = await researchSignal(ctx, symbol, data.sentiment, data.sources);
    if (analysis) {
      results.push(analysis);
    }
    await sleep(500);
  }

  return results;
}

/**
 * Research an existing position for hold/sell/add recommendations
 */
export async function researchPosition(
  ctx: HarnessContext,
  symbol: string,
  position: Position
): Promise<{
  recommendation: "SELL" | "HOLD" | "ADD";
  risk_level: "low" | "medium" | "high";
  reasoning: string;
  key_factors: string[];
} | null> {
  if (!ctx.llm) return null;

  const plPct = (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100;

  const prompt = `Analyze this position for risk and opportunity:

POSITION: ${symbol}
- Shares: ${position.qty}
- Market Value: $${position.market_value.toFixed(2)}
- P&L: $${position.unrealized_pl.toFixed(2)} (${plPct.toFixed(1)}%)
- Current Price: $${position.current_price}

Provide a brief risk assessment and recommendation (HOLD, SELL, or ADD). JSON format:
{
  "recommendation": "HOLD|SELL|ADD",
  "risk_level": "low|medium|high",
  "reasoning": "brief reason",
  "key_factors": ["factor1", "factor2"]
}`;

  try {
    const response = await ctx.llm.complete({
      model: ctx.state.config.llm_model,
      messages: [
        { role: "system", content: "You are a position risk analyst. Be concise. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      max_tokens: 200,
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const usage = response.usage;
    if (usage) {
      trackLLMCost(ctx, ctx.state.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
    }

    const content = response.content || "{}";
    const analysis = JSON.parse(content.replace(/```json\n?|```/g, "").trim()) as {
      recommendation: "HOLD" | "SELL" | "ADD";
      risk_level: "low" | "medium" | "high";
      reasoning: string;
      key_factors: string[];
    };

    ctx.state.positionResearch[symbol] = { ...analysis, timestamp: Date.now() };
    ctx.log("PositionResearch", "position_analyzed", {
      symbol,
      recommendation: analysis.recommendation,
      risk: analysis.risk_level,
    });

    return analysis;
  } catch (error) {
    ctx.log("PositionResearch", "error", { symbol, message: String(error) });
    return null;
  }
}

/**
 * Batch analysis of signals with LLM for trading recommendations
 */
export async function analyzeSignalsWithLLM(
  ctx: HarnessContext,
  signals: Signal[],
  positions: Position[],
  account: Account
): Promise<{
  recommendations: Array<{
    action: "BUY" | "SELL" | "HOLD";
    symbol: string;
    confidence: number;
    reasoning: string;
    suggested_size_pct?: number;
  }>;
  market_summary: string;
  high_conviction: string[];
}> {
  if (!ctx.llm || signals.length === 0) {
    return { recommendations: [], market_summary: "No signals to analyze", high_conviction: [] };
  }

  const aggregated = new Map<string, { symbol: string; sources: string[]; totalSentiment: number; count: number }>();
  for (const sig of signals) {
    if (!aggregated.has(sig.symbol)) {
      aggregated.set(sig.symbol, { symbol: sig.symbol, sources: [], totalSentiment: 0, count: 0 });
    }
    const agg = aggregated.get(sig.symbol)!;
    agg.sources.push(sig.source);
    agg.totalSentiment += sig.sentiment;
    agg.count++;
  }

  const candidates = Array.from(aggregated.values())
    .map(a => ({ ...a, avgSentiment: a.totalSentiment / a.count }))
    .filter(a => a.avgSentiment >= ctx.state.config.min_sentiment_score * 0.5)
    .sort((a, b) => b.avgSentiment - a.avgSentiment)
    .slice(0, 10);

  if (candidates.length === 0) {
    return { recommendations: [], market_summary: "No candidates above threshold", high_conviction: [] };
  }

  const positionSymbols = new Set(positions.map(p => p.symbol));
  const prompt = `Current Time: ${new Date().toISOString()}

ACCOUNT STATUS:
- Equity: $${account.equity.toFixed(2)}
- Cash: $${account.cash.toFixed(2)}
- Current Positions: ${positions.length}/${ctx.state.config.max_positions}

CURRENT POSITIONS:
${positions.length === 0 ? "None" : positions.map(p => {
      const entry = ctx.state.positionEntries[p.symbol];
      const holdMinutes = entry ? Math.round((Date.now() - entry.entry_time) / (1000 * 60)) : 0;
      const holdStr = holdMinutes >= 60 ? `${(holdMinutes / 60).toFixed(1)}h` : `${holdMinutes}m`;
      return `- ${p.symbol}: ${p.qty} shares, P&L: $${p.unrealized_pl.toFixed(2)} (${((p.unrealized_pl / (p.market_value - p.unrealized_pl)) * 100).toFixed(1)}%), held ${holdStr}`;
    }).join("\n")}

TOP SENTIMENT CANDIDATES:
${candidates.map(c =>
      `- ${c.symbol}: avg sentiment ${(c.avgSentiment * 100).toFixed(0)}%, sources: ${c.sources.join(", ")}, ${positionSymbols.has(c.symbol) ? "[CURRENTLY HELD]" : "[NOT HELD]"}`
    ).join("\n")}

RAW SIGNALS (top 20):
${signals.slice(0, 20).map(s =>
      `- ${s.symbol} (${s.source}): ${s.reason}`
    ).join("\n")}

TRADING RULES:
- Max position size: $${ctx.state.config.max_position_value}
- Take profit target: ${ctx.state.config.take_profit_pct}%
- Stop loss: ${ctx.state.config.stop_loss_pct}%
- Min confidence to trade: ${ctx.state.config.min_analyst_confidence}
- Min hold time before selling: ${ctx.state.config.llm_min_hold_minutes ?? 30} minutes

Analyze and provide BUY/SELL/HOLD recommendations:`;

  try {
    const response = await ctx.llm.complete({
      model: ctx.state.config.llm_analyst_model,
      messages: [
        {
          role: "system",
          content: `You are a senior trading analyst AI. Make the FINAL trading decisions based on social sentiment signals.

Rules:
- Only recommend BUY for symbols with strong conviction from multiple data points
- Recommend SELL only for positions that have been held long enough AND show deteriorating sentiment or major red flags
- Give positions time to develop - avoid selling too early just because gains are small
- Positions held less than 1-2 hours should generally be given more time unless hitting stop loss
- Consider the QUALITY of sentiment, not just quantity
- Output valid JSON only

Response format:
{
  "recommendations": [
    { "action": "BUY"|"SELL"|"HOLD", "symbol": "TICKER", "confidence": 0.0-1.0, "reasoning": "detailed reasoning", "suggested_size_pct": 10-30 }
  ],
  "market_summary": "overall market read and sentiment",
  "high_conviction_plays": ["symbols you feel strongest about"]
}`,
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 800,
      temperature: 0.4,
      response_format: { type: "json_object" }
    });

    const usage = response.usage;
    if (usage) {
      trackLLMCost(ctx, ctx.state.config.llm_analyst_model, usage.prompt_tokens, usage.completion_tokens);
    }

    const content = response.content || "{}";
    const analysis = JSON.parse(content.replace(/```json\n?|```/g, "").trim()) as {
      recommendations: Array<{
        action: "BUY" | "SELL" | "HOLD";
        symbol: string;
        confidence: number;
        reasoning: string;
        suggested_size_pct?: number;
      }>;
      market_summary: string;
      high_conviction_plays?: string[];
    };

    ctx.log("Analyst", "analysis_complete", {
      candidates: candidates.length,
      recommendations: analysis.recommendations?.length || 0,
    });

    return {
      recommendations: analysis.recommendations || [],
      market_summary: analysis.market_summary || "",
      high_conviction: analysis.high_conviction_plays || [],
    };
  } catch (error) {
    ctx.log("Analyst", "error", { message: String(error) });
    return { recommendations: [], market_summary: `Analysis failed: ${error}`, high_conviction: [] };
  }
}
