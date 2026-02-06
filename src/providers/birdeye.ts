/**
 * Birdeye API Provider
 *
 * Fetches OHLCV candlestick data for chart pattern analysis.
 * Free tier: 30,000 CU/month, 1 req/sec rate limit.
 */

export interface OHLCVCandle {
  o: number;  // Open
  h: number;  // High
  l: number;  // Low
  c: number;  // Close
  v: number;  // Volume
  unixTime: number;
  type: string;
}

export interface OHLCVResponse {
  success: boolean;
  data: {
    items: OHLCVCandle[];
  };
}

export interface ChartPattern {
  pattern: string;
  confidence: number;
  signal: "bullish" | "bearish" | "neutral";
  description: string;
}

export interface ChartLevels {
  support: number;
  resistance: number;
  distanceFromSupportPct: number;
  distanceFromResistancePct: number;
}

export interface ChartAnalysis {
  token: string;
  timeframe: string;
  candles: number;
  patterns: ChartPattern[];
  indicators: {
    trend: "up" | "down" | "sideways";
    volatility: "low" | "medium" | "high";
    volumeProfile: "accumulation" | "distribution" | "neutral";
    volumeConfirmation: "confirmed" | "diverging" | "climax";
    recentMomentum: number; // -100 to +100
    rsi: number; // 0-100
    rsiCondition: "oversold" | "neutral" | "overbought";
    momentumQuality: "fresh" | "extended" | "exhausted";
    breakoutQuality?: "strong" | "weak" | "failed" | "none";
  };
  levels: ChartLevels;
  entryScore: number; // 0-100, higher = better entry point
  recommendation: "strong_buy" | "buy" | "wait" | "avoid";
}

const BIRDEYE_BASE = "https://public-api.birdeye.so";

// Module-level timestamp to persist across provider instances
// This ensures rate limiting works even when new BirdeyeProvider instances are created
let globalLastRequest = 0;

export class BirdeyeProvider {
  private apiKey: string;
  private rateLimitDelay = 2500; // 1 req/sec on free tier, with generous safety margin

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - globalLastRequest;
    if (elapsed < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - elapsed));
    }
    globalLastRequest = Date.now();
  }

  /**
   * Fetch OHLCV candles for a token
   * @param tokenAddress Solana token address
   * @param interval Candle interval: 1m, 5m, 15m, 30m, 1H, 4H, 1D
   * @param limit Number of candles (default 100)
   */
  async getOHLCV(
    tokenAddress: string,
    interval: "1m" | "5m" | "15m" | "30m" | "1H" | "4H" | "1D" = "15m",
    limit: number = 100
  ): Promise<OHLCVCandle[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.throttle();

      const url = `${BIRDEYE_BASE}/defi/ohlcv?address=${tokenAddress}&type=${interval}&time_from=${Math.floor(Date.now() / 1000) - (limit * this.intervalToSeconds(interval))}&time_to=${Math.floor(Date.now() / 1000)}`;

      const res = await fetch(url, {
        headers: {
          "X-API-KEY": this.apiKey,
          "x-chain": "solana",
        },
      });

      if (res.ok) {
        const data: OHLCVResponse = await res.json();
        return data.data?.items || [];
      }

      // Handle rate limiting with exponential backoff
      if (res.status === 429) {
        const backoffMs = Math.min(5000 * Math.pow(2, attempt), 15000); // 5s, 10s, 15s max
        console.log(`[Birdeye] Rate limited (429), waiting ${backoffMs}ms before retry ${attempt + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        globalLastRequest = Date.now(); // Reset throttle after backoff
        lastError = new Error(`Birdeye API error: 429 (rate limited)`);
        continue;
      }

      // Non-retryable error - include status for debugging
      const errorBody = await res.text().catch(() => "");
      throw new Error(`Birdeye API error: ${res.status}${errorBody ? ` - ${errorBody.slice(0, 100)}` : ""}`);
    }

    // All retries exhausted
    throw lastError || new Error("Birdeye API: max retries exceeded");
  }

  private intervalToSeconds(interval: string): number {
    const map: Record<string, number> = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "30m": 1800,
      "1H": 3600,
      "4H": 14400,
      "1D": 86400,
    };
    return map[interval] || 900;
  }

  /**
   * Analyze chart patterns and provide entry recommendation
   * @param tokenAddress Solana token address
   * @param ageHours Token age in hours (used to select candle interval)
   */
  async analyzeChart(tokenAddress: string, ageHours?: number): Promise<ChartAnalysis | null> {
    try {
      // Dynamic interval selection based on token age:
      // - Fresh tokens (< 3 hours): Use 5m candles for more data points
      // - Older tokens (>= 3 hours): Use 15m candles for more reliable patterns
      const useShortInterval = ageHours !== undefined && ageHours < 3;
      const interval = useShortInterval ? "5m" : "15m";
      const candleCount = useShortInterval ? 30 : 50; // 30 * 5m = 2.5h, 50 * 15m = 12.5h

      const candles = await this.getOHLCV(tokenAddress, interval, candleCount);

      if (candles.length < 10) {
        return null; // Not enough data
      }

      const patterns = this.detectPatterns(candles);
      const indicators = this.calculateIndicators(candles);
      const levels = this.calculateLevels(candles);
      const entryScore = this.calculateEntryScore(patterns, indicators, candles, levels);

      let recommendation: ChartAnalysis["recommendation"];
      if (entryScore >= 70) recommendation = "strong_buy";
      else if (entryScore >= 50) recommendation = "buy";
      else if (entryScore >= 30) recommendation = "wait";
      else recommendation = "avoid";

      return {
        token: tokenAddress,
        timeframe: interval,
        candles: candles.length,
        patterns,
        indicators,
        levels,
        entryScore,
        recommendation,
      };
    } catch (e) {
      // 400 errors are expected for new tokens without OHLCV data - don't log as error
      const errorMsg = String(e);
      if (errorMsg.includes("400")) {
        // Expected case - token too new for chart data
        return null;
      }
      // Unexpected error - log it
      console.error(`[Birdeye] Chart analysis failed for ${tokenAddress}:`, e);
      return null;
    }
  }

  /**
   * Detect common chart patterns
   */
  private detectPatterns(candles: OHLCVCandle[]): ChartPattern[] {
    const patterns: ChartPattern[] = [];
    const len = candles.length;
    if (len < 5) return patterns;

    // Get recent candles (most recent last)
    const recent = candles.slice(-10);
    const closes = recent.map(c => c.c);
    const volumes = recent.map(c => c.v);
    const highs = recent.map(c => c.h);
    const lows = recent.map(c => c.l);

    // 1. Consolidation/Accumulation (tight range with volume)
    const priceRange = Math.max(...closes) - Math.min(...closes);
    const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
    const rangePercent = (priceRange / avgPrice) * 100;

    if (rangePercent < 10) {
      const avgVolRecent = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const avgVolOlder = volumes.slice(0, 5).reduce((a, b) => a + b, 0) / 5;

      if (avgVolRecent > avgVolOlder * 1.2) {
        patterns.push({
          pattern: "accumulation",
          confidence: 0.7,
          signal: "bullish",
          description: "Tight consolidation with increasing volume - potential breakout setup",
        });
      } else {
        patterns.push({
          pattern: "consolidation",
          confidence: 0.5,
          signal: "neutral",
          description: "Price consolidating in tight range",
        });
      }
    }

    // 2. Higher Lows (uptrend)
    const recentLows = lows.slice(-6);
    let higherLowCount = 0;
    for (let i = 1; i < recentLows.length; i++) {
      const curr = recentLows[i];
      const prev = recentLows[i - 1];
      if (curr !== undefined && prev !== undefined && curr > prev) higherLowCount++;
    }
    if (higherLowCount >= 4) {
      patterns.push({
        pattern: "higher_lows",
        confidence: 0.75,
        signal: "bullish",
        description: "Consistent higher lows indicating uptrend",
      });
    }

    // 3. Lower Highs (downtrend)
    const recentHighs = highs.slice(-6);
    let lowerHighCount = 0;
    for (let i = 1; i < recentHighs.length; i++) {
      const curr = recentHighs[i];
      const prev = recentHighs[i - 1];
      if (curr !== undefined && prev !== undefined && curr < prev) lowerHighCount++;
    }
    if (lowerHighCount >= 4) {
      patterns.push({
        pattern: "lower_highs",
        confidence: 0.75,
        signal: "bearish",
        description: "Consistent lower highs indicating downtrend",
      });
    }

    // 4. Volume Spike (potential reversal or breakout)
    const lastVolume = volumes[volumes.length - 1] ?? 0;
    const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
    if (lastVolume > avgVolume * 2.5) {
      const lastCandle = recent[recent.length - 1];
      if (lastCandle) {
        const isGreen = lastCandle.c > lastCandle.o;
        patterns.push({
          pattern: "volume_spike",
          confidence: 0.65,
          signal: isGreen ? "bullish" : "bearish",
          description: isGreen
            ? "High volume green candle - buying pressure"
            : "High volume red candle - selling pressure",
        });
      }
    }

    // 5. Dip Buy Opportunity (price dropped but recovering)
    const allTimeHigh = Math.max(...candles.map(c => c.h));
    const currentPrice = closes[closes.length - 1] ?? 0;
    const dropFromATH = allTimeHigh > 0 ? ((allTimeHigh - currentPrice) / allTimeHigh) * 100 : 0;
    const lastThreeGreen = recent.slice(-3).every(c => c.c > c.o);

    if (dropFromATH > 20 && dropFromATH < 50 && lastThreeGreen) {
      patterns.push({
        pattern: "dip_recovery",
        confidence: 0.6,
        signal: "bullish",
        description: `Price ${dropFromATH.toFixed(0)}% off high but showing recovery with 3 green candles`,
      });
    }

    // 6. Overextended (buying the top)
    const firstClose = closes[0] ?? 1;
    const recentGains = ((currentPrice - firstClose) / firstClose) * 100;
    if (recentGains > 50) {
      patterns.push({
        pattern: "overextended",
        confidence: 0.7,
        signal: "bearish",
        description: `Price up ${recentGains.toFixed(0)}% in short period - risk of pullback`,
      });
    }

    // 7. Support Test (bouncing off support)
    const supportLows = lows.slice(-10);
    const support = supportLows.length > 0 ? Math.min(...supportLows) : 0;
    const lastLow = lows[lows.length - 1] ?? 0;
    const lastRecentCandle = recent[recent.length - 1];
    if (support > 0 && lastRecentCandle && Math.abs(lastLow - support) / support < 0.02 && lastRecentCandle.c > lastRecentCandle.o) {
      patterns.push({
        pattern: "support_bounce",
        confidence: 0.65,
        signal: "bullish",
        description: "Price bouncing off support level with green candle",
      });
    }

    // 8. Accumulation Breakout (tight consolidation + volume + price breaking out)
    if (len >= 15 && rangePercent < 8) {
      // Check if we have 10+ candles in consolidation
      const consolidationCandles = candles.slice(-15, -3);
      const consolidationHigh = Math.max(...consolidationCandles.map(c => c.h));
      const consolidationLow = Math.min(...consolidationCandles.map(c => c.l));
      const consolidationRange = consolidationHigh > 0
        ? ((consolidationHigh - consolidationLow) / consolidationHigh) * 100
        : 100;

      // Check if last 3 candles have increasing volume
      const last3Volumes = volumes.slice(-3);
      const volumeIncreasing = last3Volumes.length === 3 &&
        last3Volumes[1]! > last3Volumes[0]! &&
        last3Volumes[2]! > last3Volumes[1]!;

      // Check if price is breaking above consolidation
      const breakingOut = currentPrice > consolidationHigh;

      if (consolidationRange < 15 && volumeIncreasing && breakingOut) {
        patterns.push({
          pattern: "accumulation_breakout",
          confidence: 0.8,
          signal: "bullish",
          description: "Breaking out of tight consolidation with increasing volume - high conviction entry",
        });
      }
    }

    return patterns;
  }

  /**
   * Calculate technical indicators
   */
  private calculateIndicators(candles: OHLCVCandle[]): ChartAnalysis["indicators"] {
    const closes = candles.map(c => c.c);
    const volumes = candles.map(c => c.v);
    const highs = candles.map(c => c.h);
    const len = closes.length;

    // Trend: Compare recent price to earlier price
    const recentSlice = closes.slice(-5);
    const olderSlice = closes.slice(-15, -10);
    const recentAvg = recentSlice.length > 0 ? recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length : 0;
    const olderAvg = olderSlice.length > 0 ? olderSlice.reduce((a, b) => a + b, 0) / olderSlice.length : recentAvg;
    const trendPct = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;

    let trend: "up" | "down" | "sideways";
    if (trendPct > 5) trend = "up";
    else if (trendPct < -5) trend = "down";
    else trend = "sideways";

    // Volatility: Standard deviation of returns
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const curr = closes[i];
      const prev = closes[i - 1];
      if (curr !== undefined && prev !== undefined && prev !== 0) {
        returns.push((curr - prev) / prev);
      }
    }
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 0 ? returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length : 0;
    const stdDev = Math.sqrt(variance);

    let volatility: "low" | "medium" | "high";
    if (stdDev < 0.02) volatility = "low";
    else if (stdDev < 0.05) volatility = "medium";
    else volatility = "high";

    // Volume Profile: Compare recent volume to older volume with price direction
    const recentVolSlice = volumes.slice(-5);
    const olderVolSlice = volumes.slice(-15, -10);
    const recentVol = recentVolSlice.length > 0 ? recentVolSlice.reduce((a, b) => a + b, 0) : 0;
    const olderVol = olderVolSlice.length > 0 ? olderVolSlice.reduce((a, b) => a + b, 0) : recentVol;
    const volChange = olderVol > 0 ? recentVol / olderVol : 1;

    let volumeProfile: "accumulation" | "distribution" | "neutral";
    if (volChange > 1.3 && trend === "up") volumeProfile = "accumulation";
    else if (volChange > 1.3 && trend === "down") volumeProfile = "distribution";
    else volumeProfile = "neutral";

    // Volume Confirmation: Check if volume confirms price action
    // Look at last 5 candles - does volume increase on green candles?
    let volumeConfirmation: "confirmed" | "diverging" | "climax";
    const recent5 = candles.slice(-5);
    let greenVolumeSum = 0;
    let redVolumeSum = 0;
    let greenCount = 0;
    let redCount = 0;
    for (const c of recent5) {
      if (c.c > c.o) {
        greenVolumeSum += c.v;
        greenCount++;
      } else {
        redVolumeSum += c.v;
        redCount++;
      }
    }
    const avgGreenVol = greenCount > 0 ? greenVolumeSum / greenCount : 0;
    const avgRedVol = redCount > 0 ? redVolumeSum / redCount : 0;
    const lastCandle = candles[len - 1];
    const avgVolAll = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    // Climax: extreme volume spike (3x average)
    if (lastCandle && lastCandle.v > avgVolAll * 3) {
      volumeConfirmation = "climax";
    }
    // Confirmed: volume higher on green candles than red (bullish) OR volume higher on red than green (bearish trend confirmed)
    else if (trend === "up" && avgGreenVol > avgRedVol * 1.2) {
      volumeConfirmation = "confirmed";
    } else if (trend === "down" && avgRedVol > avgGreenVol * 1.2) {
      volumeConfirmation = "confirmed";
    }
    // Diverging: price up but red volume > green volume (weak)
    else if (trend === "up" && avgRedVol > avgGreenVol) {
      volumeConfirmation = "diverging";
    } else if (trend === "down" && avgGreenVol > avgRedVol) {
      volumeConfirmation = "diverging";
    } else {
      volumeConfirmation = "confirmed"; // Neutral case
    }

    // Recent Momentum: Price change over last 5 candles scaled to -100 to +100
    const currentClose = closes[len - 1] ?? 0;
    const olderClose = closes[len - 6] ?? currentClose;
    const momentumPct = olderClose > 0 ? ((currentClose - olderClose) / olderClose) * 100 : 0;
    const recentMomentum = Math.max(-100, Math.min(100, momentumPct * 2));

    // RSI Calculation (14-period or available candles)
    const rsi = this.calculateRSI(closes);
    let rsiCondition: "oversold" | "neutral" | "overbought";
    if (rsi < 30) rsiCondition = "oversold";
    else if (rsi > 70) rsiCondition = "overbought";
    else rsiCondition = "neutral";

    // Momentum Quality: Is this a fresh move or exhausted?
    let momentumQuality: "fresh" | "extended" | "exhausted";
    const momentum5 = len >= 6 ? ((closes[len - 1]! - closes[len - 6]!) / closes[len - 6]!) * 100 : 0;
    const momentum10 = len >= 11 ? ((closes[len - 1]! - closes[len - 11]!) / closes[len - 11]!) * 100 : 0;

    if (rsi < 50 && momentum5 > 5) {
      // Starting from low RSI and moving up = fresh
      momentumQuality = "fresh";
    } else if (rsi > 65 && momentum5 > 0 && momentum10 > 30) {
      // High RSI with sustained gains = extended
      momentumQuality = "extended";
    } else if (rsi > 60 && momentum5 < momentum10 * 0.3) {
      // RSI elevated but momentum fading = exhausted
      momentumQuality = "exhausted";
    } else if (momentum5 < -5 && trend === "down") {
      momentumQuality = "exhausted";
    } else {
      momentumQuality = "fresh";
    }

    // Breakout Quality: Did price break resistance with volume?
    let breakoutQuality: "strong" | "weak" | "failed" | "none" = "none";
    if (len >= 20) {
      const resistance = Math.max(...highs.slice(-20, -5)); // Recent resistance (excluding last 5)
      const currentHigh = highs[len - 1] ?? 0;
      const prevHigh = highs[len - 2] ?? 0;

      // Check if we broke above resistance
      if (currentHigh > resistance || prevHigh > resistance) {
        const breakoutCandles = candles.slice(-3);
        const breakoutVolume = breakoutCandles.reduce((sum, c) => sum + c.v, 0) / 3;
        const priorVolume = candles.slice(-10, -3).reduce((sum, c) => sum + c.v, 0) / 7;

        // Strong: broke resistance with 2x+ volume
        if (breakoutVolume > priorVolume * 2 && currentClose > resistance) {
          breakoutQuality = "strong";
        }
        // Failed: broke but closed back below
        else if (currentClose < resistance && prevHigh > resistance) {
          breakoutQuality = "failed";
        }
        // Weak: broke but without volume confirmation
        else if (breakoutVolume < priorVolume * 1.5) {
          breakoutQuality = "weak";
        } else {
          breakoutQuality = "strong";
        }
      }
    }

    return {
      trend,
      volatility,
      volumeProfile,
      volumeConfirmation,
      recentMomentum,
      rsi,
      rsiCondition,
      momentumQuality,
      breakoutQuality,
    };
  }

  /**
   * Calculate RSI (Relative Strength Index)
   * Uses available candles, ideally 14 periods
   */
  private calculateRSI(closes: number[]): number {
    const period = Math.min(14, closes.length - 1);
    if (period < 2) return 50; // Not enough data

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i]! - closes[i - 1]!;
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100; // No losses = max RSI
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate support and resistance levels
   */
  private calculateLevels(candles: OHLCVCandle[]): ChartLevels {
    const len = candles.length;
    const lookback = Math.min(20, len);
    const recentCandles = candles.slice(-lookback);

    const lows = recentCandles.map(c => c.l);
    const highs = recentCandles.map(c => c.h);
    const currentPrice = candles[len - 1]?.c ?? 0;

    const support = Math.min(...lows);
    const resistance = Math.max(...highs);

    const distanceFromSupportPct = support > 0
      ? ((currentPrice - support) / support) * 100
      : 0;
    const distanceFromResistancePct = resistance > 0
      ? ((resistance - currentPrice) / resistance) * 100
      : 0;

    return {
      support,
      resistance,
      distanceFromSupportPct,
      distanceFromResistancePct,
    };
  }

  /**
   * Calculate entry score (0-100)
   */
  private calculateEntryScore(
    patterns: ChartPattern[],
    indicators: ChartAnalysis["indicators"],
    candles: OHLCVCandle[],
    levels: ChartLevels
  ): number {
    let score = 50; // Start neutral

    // Pattern contributions
    for (const pattern of patterns) {
      if (pattern.signal === "bullish") {
        score += pattern.confidence * 15;
      } else if (pattern.signal === "bearish") {
        score -= pattern.confidence * 20; // Penalize bearish more
      }
    }

    // Indicator contributions
    if (indicators.trend === "up") score += 10;
    else if (indicators.trend === "down") score -= 15;

    if (indicators.volumeProfile === "accumulation") score += 15;
    else if (indicators.volumeProfile === "distribution") score -= 20;

    if (indicators.volatility === "high") score -= 5; // Slight penalty for high volatility

    // Volume Confirmation contributions
    if (indicators.volumeConfirmation === "confirmed") score += 10;
    else if (indicators.volumeConfirmation === "diverging") score -= 15;
    else if (indicators.volumeConfirmation === "climax") {
      // Climax can be good or bad depending on candle color
      const lastCandle = candles[candles.length - 1];
      if (lastCandle && lastCandle.c < lastCandle.o) {
        score -= 25; // Red climax = distribution/dump
      }
    }

    // RSI contributions
    if (indicators.rsiCondition === "oversold") score += 15; // Bounce opportunity
    else if (indicators.rsiCondition === "overbought") score -= 20; // Buying the top

    // Momentum Quality contributions
    if (indicators.momentumQuality === "fresh") score += 10;
    else if (indicators.momentumQuality === "exhausted") score -= 15;
    // "extended" is neutral

    // Breakout Quality contributions
    if (indicators.breakoutQuality === "strong") score += 20; // High conviction entry
    else if (indicators.breakoutQuality === "weak") score -= 10;
    else if (indicators.breakoutQuality === "failed") score -= 25; // Failed breakout = bearish

    // Momentum contribution (favor moderate positive momentum, not overextended)
    if (indicators.recentMomentum > 0 && indicators.recentMomentum < 30) {
      score += 10; // Good positive momentum
    } else if (indicators.recentMomentum > 50) {
      score -= 10; // Might be buying the top
    } else if (indicators.recentMomentum < -20) {
      score -= 10; // Falling knife
    }

    // Support/Resistance level contributions
    if (levels.distanceFromSupportPct < 10) {
      score += 15; // Near support = good entry
    }
    if (levels.distanceFromResistancePct < 5) {
      score -= 20; // Near resistance = bad entry
    } else if (levels.distanceFromResistancePct > 15 && levels.distanceFromResistancePct < 40) {
      score += 10; // Buying a dip with room to run
    }

    return Math.max(0, Math.min(100, score));
  }
}


export function createBirdeyeProvider(apiKey: string | undefined): BirdeyeProvider | null {
  if (!apiKey) {
    console.log("[Birdeye] No API key provided - chart analysis disabled");
    return null;
  }
  return new BirdeyeProvider(apiKey);
}
