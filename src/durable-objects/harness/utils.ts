/**
 * Utility functions for MahoragaHarness
 *
 * Pure utility functions that don't depend on class state.
 */

import type { DexTradeRecord, DexTradingMetrics, SolPriceCache } from "./types";
import { SOURCE_CONFIG } from "./types";
import { TICKER_BLACKLIST } from "./config";

// ============================================================================
// CRYPTO SYMBOL UTILITIES
// ============================================================================

export function normalizeCryptoSymbol(symbol: string): string {
  if (symbol.includes("/")) {
    return symbol.toUpperCase();
  }
  const match = symbol.toUpperCase().match(/^([A-Z]{2,5})(USD|USDT|USDC)$/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return symbol;
}

export function isCryptoSymbol(symbol: string, cryptoSymbols: string[]): boolean {
  const normalizedInput = normalizeCryptoSymbol(symbol);
  for (const configSymbol of cryptoSymbols) {
    if (normalizeCryptoSymbol(configSymbol) === normalizedInput) {
      return true;
    }
  }
  return /^[A-Z]{2,5}\/(USD|USDT|USDC)$/.test(normalizedInput);
}

// ============================================================================
// TIME DECAY AND ENGAGEMENT UTILITIES
// ============================================================================

/**
 * [TUNE] Time decay - how quickly old posts lose weight
 * Uses exponential decay with half-life from SOURCE_CONFIG.decayHalfLifeMinutes
 * Modify the min/max clamp values (0.2-1.0) to change bounds
 */
export function calculateTimeDecay(postTimestamp: number): number {
  const ageMinutes = (Date.now() - postTimestamp * 1000) / 60000;
  const halfLife = SOURCE_CONFIG.decayHalfLifeMinutes;
  const decay = Math.pow(0.5, ageMinutes / halfLife);
  return Math.max(0.2, Math.min(1.0, decay));
}

export function getEngagementMultiplier(upvotes: number, comments: number): number {
  let upvoteMultiplier = 0.8;
  const upvoteThresholds = Object.entries(SOURCE_CONFIG.engagement.upvotes).sort(
    ([a], [b]) => Number(b) - Number(a)
  );
  for (const [threshold, mult] of upvoteThresholds) {
    if (upvotes >= parseInt(threshold)) {
      upvoteMultiplier = mult as number;
      break;
    }
  }

  let commentMultiplier = 0.9;
  const commentThresholds = Object.entries(SOURCE_CONFIG.engagement.comments).sort(
    ([a], [b]) => Number(b) - Number(a)
  );
  for (const [threshold, mult] of commentThresholds) {
    if (comments >= parseInt(threshold)) {
      commentMultiplier = mult as number;
      break;
    }
  }

  return (upvoteMultiplier + commentMultiplier) / 2;
}

/** [TUNE] Flair multiplier - boost/penalize based on Reddit post flair */
export function getFlairMultiplier(flair: string | null | undefined): number {
  if (!flair) return 1.0;
  return SOURCE_CONFIG.flairMultipliers[flair.trim()] || 1.0;
}

// ============================================================================
// TICKER EXTRACTION AND SENTIMENT
// ============================================================================

/**
 * [CUSTOMIZABLE] Ticker extraction - modify regex to change what counts as a ticker
 * Current: $SYMBOL or SYMBOL followed by trading keywords
 * Add patterns for your data sources (e.g., cashtags, mentions)
 */
export function extractTickers(text: string, customBlacklist: string[] = []): string[] {
  const matches = new Set<string>();
  const customSet = new Set(customBlacklist.map((t) => t.toUpperCase()));
  const regex =
    /\$([A-Z]{1,5})\b|\b([A-Z]{2,5})\b(?=\s+(?:calls?|puts?|stock|shares?|moon|rocket|yolo|buy|sell|long|short))/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const ticker = (match[1] || match[2] || "").toUpperCase();
    if (
      ticker.length >= 2 &&
      ticker.length <= 5 &&
      !TICKER_BLACKLIST.has(ticker) &&
      !customSet.has(ticker)
    ) {
      matches.add(ticker);
    }
  }
  return Array.from(matches);
}

/**
 * [CUSTOMIZABLE] Sentiment detection - keyword-based bullish/bearish scoring
 * Add/remove words to match your trading style
 * Returns -1 (bearish) to +1 (bullish)
 */
export function detectSentiment(text: string): number {
  const lower = text.toLowerCase();
  const bullish = [
    "moon",
    "rocket",
    "buy",
    "calls",
    "long",
    "bullish",
    "yolo",
    "tendies",
    "gains",
    "diamond",
    "squeeze",
    "pump",
    "green",
    "up",
    "breakout",
    "undervalued",
    "accumulate",
  ];
  const bearish = [
    "puts",
    "short",
    "sell",
    "bearish",
    "crash",
    "dump",
    "drill",
    "tank",
    "rip",
    "red",
    "down",
    "bag",
    "overvalued",
    "bubble",
    "avoid",
  ];

  let bull = 0,
    bear = 0;
  for (const w of bullish) if (lower.includes(w)) bull++;
  for (const w of bearish) if (lower.includes(w)) bear++;

  const total = bull + bear;
  if (total === 0) return 0;
  return (bull - bear) / total;
}

// ============================================================================
// DEX SLIPPAGE CALCULATION
// ============================================================================

/**
 * Calculate DEX slippage based on liquidity and position size
 *
 * Real DEX trades have 1-5%+ slippage due to:
 * - AMM price impact (larger trades move price more)
 * - Low liquidity pools have higher slippage
 * - MEV/frontrunning can add extra slippage
 *
 * Formula: slippage_pct = base_slippage + (position_usd / liquidity_usd) * multiplier
 *
 * @param model - Slippage model: 'none', 'conservative', 'realistic'
 * @param positionUsd - Position size in USD
 * @param liquidityUsd - Pool liquidity in USD
 * @returns Slippage as a decimal (e.g., 0.02 = 2%)
 */
export function calculateDexSlippage(
  model: "none" | "conservative" | "realistic",
  positionUsd: number,
  liquidityUsd: number
): number {
  if (model === "none") return 0;

  // Prevent division by zero
  if (liquidityUsd <= 0) liquidityUsd = 1;

  // Model parameters
  const params = {
    conservative: { baseSlippage: 0.005, multiplier: 2 }, // 0.5% base + 2x impact
    realistic: { baseSlippage: 0.01, multiplier: 5 }, // 1% base + 5x impact
  };

  const { baseSlippage, multiplier } = params[model];

  // Calculate price impact: larger position relative to liquidity = more slippage
  const priceImpact = (positionUsd / liquidityUsd) * multiplier;

  // Total slippage = base + impact, capped at reasonable max (15%)
  const totalSlippage = Math.min(baseSlippage + priceImpact, 0.15);

  return totalSlippage;
}

// ============================================================================
// DEX TRADING METRICS CALCULATION (#15, #16, #17)
// ============================================================================

export function calculateDexTradingMetrics(
  tradeHistory: DexTradeRecord[],
  state: {
    dexMaxConsecutiveLosses: number;
    dexCurrentLossStreak: number;
    dexMaxDrawdownPct: number;
    dexMaxDrawdownDuration: number;
    dexDrawdownStartTime: number | null;
    dexPeakBalance: number;
    dexPaperBalance: number;
  }
): DexTradingMetrics {
  const defaultMetrics: DexTradingMetrics = {
    winRate: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    expectancy: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    maxConsecutiveLosses: state.dexMaxConsecutiveLosses || 0,
    currentLossStreak: state.dexCurrentLossStreak || 0,
    maxDrawdownPct: state.dexMaxDrawdownPct || 0,
    maxDrawdownDuration: state.dexMaxDrawdownDuration || 0,
    currentDrawdownPct: 0,
  };

  if (!tradeHistory || tradeHistory.length === 0) {
    return defaultMetrics;
  }

  // Separate winning and losing trades
  const winningTrades = tradeHistory.filter((t) => t.pnlPct > 0);
  const losingTrades = tradeHistory.filter((t) => t.pnlPct <= 0);

  const totalTrades = tradeHistory.length;
  const winningCount = winningTrades.length;

  // #15: Win rate calculation
  const winRate = totalTrades > 0 ? winningCount / totalTrades : 0;

  // #15: Average win/loss percentage
  const avgWinPct =
    winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.pnlPct, 0) / winningTrades.length
      : 0;

  const avgLossPct =
    losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.pnlPct, 0) / losingTrades.length
      : 0;

  // #15: Expectancy = (win_rate * avg_win) - ((1-win_rate) * abs(avg_loss))
  const expectancy = winRate * avgWinPct - (1 - winRate) * Math.abs(avgLossPct);

  // #15: Profit factor = sum(winning pnl) / abs(sum(losing pnl))
  const totalWinSol = winningTrades.reduce((sum, t) => sum + t.pnlSol, 0);
  const totalLossSol = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlSol, 0));
  const profitFactor =
    totalLossSol > 0 ? totalWinSol / totalLossSol : totalWinSol > 0 ? Infinity : 0;

  // #16: Sharpe ratio = mean(trade_returns) / std(trade_returns)
  const returns = tradeHistory.map((t) => t.pnlPct);
  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  const squaredDiffs = returns.map((r) => Math.pow(r - meanReturn, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  const sharpeRatio = stdDev > 0 ? meanReturn / stdDev : 0;

  // #17: Calculate current drawdown
  const peakBalance = state.dexPeakBalance || 1.0;
  const currentBalance = state.dexPaperBalance || 1.0;
  const currentDrawdownPct =
    peakBalance > 0 ? ((peakBalance - currentBalance) / peakBalance) * 100 : 0;

  return {
    winRate,
    avgWinPct,
    avgLossPct,
    expectancy,
    profitFactor: profitFactor === Infinity ? 999 : profitFactor, // Cap infinite profit factor for display
    sharpeRatio,
    maxConsecutiveLosses: state.dexMaxConsecutiveLosses || 0,
    currentLossStreak: state.dexCurrentLossStreak || 0,
    maxDrawdownPct: state.dexMaxDrawdownPct || 0,
    maxDrawdownDuration: state.dexMaxDrawdownDuration || 0,
    currentDrawdownPct: Math.max(0, currentDrawdownPct),
  };
}

// Helper to update streak and drawdown state after a trade
export function updateStreakAndDrawdownState(
  isWin: boolean,
  currentBalance: number,
  state: {
    dexMaxConsecutiveLosses: number;
    dexCurrentLossStreak: number;
    dexMaxDrawdownPct: number;
    dexMaxDrawdownDuration: number;
    dexDrawdownStartTime: number | null;
    dexPeakBalance: number;
  }
): void {
  const now = Date.now();

  // Update loss streak tracking
  if (!isWin) {
    // Losing trade - increment streak
    state.dexCurrentLossStreak = (state.dexCurrentLossStreak || 0) + 1;
    if (state.dexCurrentLossStreak > (state.dexMaxConsecutiveLosses || 0)) {
      state.dexMaxConsecutiveLosses = state.dexCurrentLossStreak;
    }
  } else {
    // Winning trade - reset loss streak
    state.dexCurrentLossStreak = 0;
  }

  // Update peak balance and drawdown tracking
  if (currentBalance > (state.dexPeakBalance || 0)) {
    // New peak - update peak and clear drawdown start time
    state.dexPeakBalance = currentBalance;

    // If we were in a drawdown, record its duration
    if (state.dexDrawdownStartTime !== null) {
      const drawdownDuration = now - state.dexDrawdownStartTime;
      if (drawdownDuration > (state.dexMaxDrawdownDuration || 0)) {
        state.dexMaxDrawdownDuration = drawdownDuration;
      }
      state.dexDrawdownStartTime = null;
    }
  } else {
    // We're in a drawdown
    const drawdownPct =
      ((state.dexPeakBalance - currentBalance) / state.dexPeakBalance) * 100;

    if (drawdownPct > (state.dexMaxDrawdownPct || 0)) {
      state.dexMaxDrawdownPct = drawdownPct;
    }

    // Start tracking drawdown duration if not already
    if (state.dexDrawdownStartTime === null) {
      state.dexDrawdownStartTime = now;
    }
  }
}

// ============================================================================
// VALID TICKER CACHE
// ============================================================================

export class ValidTickerCache {
  private secTickers: Set<string> | null = null;
  private lastSecRefresh = 0;
  private alpacaCache: Map<string, boolean> = new Map();
  private readonly SEC_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  async refreshSecTickersIfNeeded(): Promise<void> {
    if (this.secTickers && Date.now() - this.lastSecRefresh < this.SEC_REFRESH_INTERVAL_MS) {
      return;
    }
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": "Mahoraga Trading Bot" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as Record<
        string,
        { cik_str: number; ticker: string; title: string }
      >;
      this.secTickers = new Set(Object.values(data).map((e) => e.ticker.toUpperCase()));
      this.lastSecRefresh = Date.now();
    } catch {
      // Keep existing cache on failure
    }
  }

  isKnownSecTicker(symbol: string): boolean {
    return this.secTickers?.has(symbol.toUpperCase()) ?? false;
  }

  getCachedValidation(symbol: string): boolean | undefined {
    return this.alpacaCache.get(symbol.toUpperCase());
  }

  setCachedValidation(symbol: string, isValid: boolean): void {
    this.alpacaCache.set(symbol.toUpperCase(), isValid);
  }

  async validateWithAlpaca(
    symbol: string,
    alpaca: { trading: { getAsset(s: string): Promise<{ tradable: boolean } | null> } }
  ): Promise<boolean> {
    const upper = symbol.toUpperCase();
    const cached = this.alpacaCache.get(upper);
    if (cached !== undefined) return cached;

    try {
      const asset = await alpaca.trading.getAsset(upper);
      const isValid = asset !== null && asset.tradable;
      this.alpacaCache.set(upper, isValid);
      return isValid;
    } catch {
      this.alpacaCache.set(upper, false);
      return false;
    }
  }
}

// Singleton instance for the ticker cache
export const tickerCache = new ValidTickerCache();

// ============================================================================
// SOL PRICE CACHE - Fetch real SOL/USD price with 5-minute cache
// ============================================================================

let solPriceCache: SolPriceCache | null = null;
const SOL_PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SOL_PRICE_FALLBACK = 200; // Fallback if API fails

export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();

  // Return cached price if still valid
  if (solPriceCache && now - solPriceCache.timestamp < SOL_PRICE_CACHE_TTL_MS) {
    return solPriceCache.price;
  }

  try {
    // Use DexScreener API to get SOL price (SOL/USDC pair on Raydium)
    const res = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      { headers: { "User-Agent": "MahoragaBot/1.0" } }
    );

    if (!res.ok) {
      throw new Error(`DexScreener API returned ${res.status}`);
    }

    const data = (await res.json()) as {
      pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
    };

    // Find the highest liquidity SOL pair for best price accuracy
    const pairs = data.pairs || [];
    const solPair = pairs
      .filter((p) => p.priceUsd && p.liquidity?.usd && p.liquidity.usd > 100000)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    if (solPair?.priceUsd) {
      const price = parseFloat(solPair.priceUsd);
      if (!isNaN(price) && price > 0) {
        solPriceCache = { price, timestamp: now };
        console.log(`[SolPrice] Fetched real SOL price: $${price.toFixed(2)}`);
        return price;
      }
    }

    throw new Error("No valid SOL price found in DexScreener response");
  } catch (error) {
    console.error(
      `[SolPrice] Failed to fetch SOL price: ${error}. Using fallback: $${SOL_PRICE_FALLBACK}`
    );
    // Return cached price if available (even if stale), otherwise fallback
    return solPriceCache?.price || SOL_PRICE_FALLBACK;
  }
}
