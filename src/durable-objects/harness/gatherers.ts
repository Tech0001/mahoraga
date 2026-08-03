/**
 * Data Gatherers Module
 *
 * Extracted data gathering functions from MahoragaHarness.
 * Handles fetching signals from StockTwits, crypto markets, and DEX momentum.
 * (Reddit gatherer removed 2026-08-03: Reddit's API lockdown 403s all
 * unauthenticated JSON access; StockTwits carries the sentiment lane.)
 */

import type { HarnessContext } from "./context";
import type { Signal, SocialHistoryEntry, SocialSnapshotCacheEntry } from "./types";
import { SOURCE_CONFIG } from "./types";
import {
  calculateTimeDecay,
  tickerCache,
} from "./utils";
import { createAlpacaProviders } from "../../providers/alpaca";
import { createDexScreenerProvider } from "../../providers/dexscreener";
import { scanMomoCandidates } from "../../providers/tradingview";
import { readChart } from "./chart-structure";

/**
 * Helper function for sleeping (used for rate limiting).
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run all data gatherers and update signal cache.
 * Orchestrates StockTwits and crypto data gathering.
 */
export async function runDataGatherers(ctx: HarnessContext): Promise<void> {
  ctx.log("System", "gathering_data", {});

  await tickerCache.refreshSecTickersIfNeeded();

  const [stocktwitsSignals, cryptoSignals] = await Promise.all([
    gatherStockTwits(ctx),
    gatherCrypto(ctx),
  ]);

  const allSignals = [...stocktwitsSignals, ...cryptoSignals];

  const MAX_SIGNALS = 200;
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const eligibleSignals = allSignals.filter(s => now - s.timestamp < MAX_AGE_MS);

  // Aggregate social volume/sentiment per symbol BEFORE the top-N slice so
  // staleness exits and entry records see the full cross-source picture.
  const socialSnapshot = buildSocialSnapshot(eligibleSignals);
  updateSocialHistoryFromSnapshot(ctx, socialSnapshot, now);
  ctx.state.socialSnapshotCache = {};
  for (const [symbol, s] of socialSnapshot) {
    ctx.state.socialSnapshotCache[symbol] = {
      volume: s.volume,
      sentiment: s.sentiment,
      sources: Array.from(s.sources),
    };
  }
  ctx.state.socialSnapshotCacheUpdatedAt = now;

  const freshSignals = eligibleSignals
    .slice()
    .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
    .slice(0, MAX_SIGNALS);

  ctx.state.signalCache = freshSignals;

  ctx.log("System", "data_gathered", {
    stocktwits: stocktwitsSignals.length,
    crypto: cryptoSignals.length,
    total: ctx.state.signalCache.length,
  });
}

/**
 * Aggregate signals into per-symbol social volume / volume-weighted sentiment.
 * Ported from upstream ygwyg/MAHORAGA PR #27 (social staleness v2).
 */
export function buildSocialSnapshot(
  signals: Signal[]
): Map<string, { volume: number; sentiment: number; sources: Set<string> }> {
  const aggregated = new Map<string, { volume: number; sentimentNumerator: number; sources: Set<string> }>();

  for (const sig of signals) {
    if (!sig.symbol) continue;
    const volume = Number.isFinite(sig.volume) && sig.volume > 0 ? sig.volume : 1;

    let entry = aggregated.get(sig.symbol);
    if (!entry) {
      entry = { volume: 0, sentimentNumerator: 0, sources: new Set() };
      aggregated.set(sig.symbol, entry);
    }
    entry.volume += volume;
    entry.sentimentNumerator += (Number.isFinite(sig.sentiment) ? sig.sentiment : 0) * volume;
    entry.sources.add(sig.source_detail || sig.source);
  }

  const out = new Map<string, { volume: number; sentiment: number; sources: Set<string> }>();
  for (const [symbol, entry] of aggregated) {
    out.set(symbol, {
      volume: entry.volume,
      sentiment: entry.volume > 0 ? entry.sentimentNumerator / entry.volume : 0,
      sources: entry.sources,
    });
  }
  return out;
}

function pruneSocialHistoryInPlace(history: SocialHistoryEntry[], cutoffMs: number): void {
  if (history.length === 0) return;
  const pruned = history.filter(entry => entry.timestamp >= cutoffMs);
  pruned.sort((a, b) => a.timestamp - b.timestamp);
  history.splice(0, history.length, ...pruned);
}

/**
 * Fold a snapshot into per-symbol history: 5-minute buckets, 24h retention.
 * Untouched symbols still get pruned so history cannot grow unbounded.
 */
export function updateSocialHistoryFromSnapshot(
  ctx: HarnessContext,
  snapshot: Map<string, { volume: number; sentiment: number; sources: Set<string> }>,
  nowMs: number
): void {
  const SOCIAL_HISTORY_BUCKET_MS = 5 * 60 * 1000;
  const SOCIAL_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const cutoff = nowMs - SOCIAL_HISTORY_MAX_AGE_MS;

  const touchedSymbols = new Set<string>();
  for (const [symbol, s] of snapshot) {
    touchedSymbols.add(symbol);
    const history = ctx.state.socialHistory[symbol] ?? [];
    if (history.length > 1) history.sort((a, b) => a.timestamp - b.timestamp);
    const last = history[history.length - 1];

    if (last && nowMs - last.timestamp < SOCIAL_HISTORY_BUCKET_MS) {
      last.timestamp = nowMs;
      last.volume = s.volume;
      last.sentiment = s.sentiment;
    } else {
      history.push({ timestamp: nowMs, volume: s.volume, sentiment: s.sentiment });
    }

    pruneSocialHistoryInPlace(history, cutoff);
    if (history.length === 0) {
      delete ctx.state.socialHistory[symbol];
    } else {
      ctx.state.socialHistory[symbol] = history;
    }
  }

  for (const symbol of Object.keys(ctx.state.socialHistory)) {
    if (touchedSymbols.has(symbol)) continue;
    const history = ctx.state.socialHistory[symbol];
    if (!history || history.length === 0) {
      delete ctx.state.socialHistory[symbol];
      continue;
    }
    pruneSocialHistoryInPlace(history, cutoff);
    if (history.length === 0) {
      delete ctx.state.socialHistory[symbol];
    }
  }
}

/**
 * Read the aggregated social snapshot, rebuilding from the signal cache if a
 * gather pass has not populated it yet (e.g. cold start).
 */
export function getSocialSnapshotCache(ctx: HarnessContext): Record<string, SocialSnapshotCacheEntry> {
  if (ctx.state.socialSnapshotCacheUpdatedAt > 0) {
    return ctx.state.socialSnapshotCache;
  }

  const fallback = buildSocialSnapshot(ctx.state.signalCache);
  const out: Record<string, SocialSnapshotCacheEntry> = {};
  for (const [symbol, s] of fallback) {
    out[symbol] = { volume: s.volume, sentiment: s.sentiment, sources: Array.from(s.sources) };
  }
  return out;
}

/**
 * Refresh the momo watchlist from the TradingView screener. Informational
 * lane: ranked candidates land in state for the dashboard, premarket plan,
 * and the future opening-drive module — no trading decisions made here.
 */
export async function gatherMomoWatchlist(
  ctx: HarnessContext,
  premarket: boolean,
  sessionOpenMs: number | null
): Promise<void> {
  const cfg = ctx.state.config;
  const candidates = await scanMomoCandidates({
    premarket,
    minChangePct: cfg.momo_min_change_pct ?? 4,
    minRvol: cfg.momo_min_rvol ?? 2,
    minVolume: cfg.momo_min_volume ?? 300_000,
    priceMin: cfg.momo_price_min ?? 2,
    priceMax: cfg.momo_price_max ?? 60,
    limit: cfg.momo_watchlist_size ?? 12,
  });

  ctx.state.momoWatchlist = candidates;
  ctx.state.momoWatchlistUpdatedAt = Date.now();

  // Chart-structure enrichment: read the bars for the top names so every row
  // carries a setup label and pre-planned trigger/stop before any order logic
  // ever sees it. Alpaca free tier: ~2 requests per enriched symbol/scan.
  const ENRICH_TOP_N = 8;
  const alpaca = createAlpacaProviders(ctx.env);
  const nowMs = Date.now();
  const etDayKey = new Date().toISOString().slice(0, 10);
  const charts: typeof ctx.state.momoCharts = {};

  for (const cand of candidates.slice(0, ENRICH_TOP_N)) {
    try {
      const minuteBars = await alpaca.marketData.getBars(cand.symbol, "1Min", {
        start: new Date(nowMs - 12 * 3600 * 1000).toISOString(),
        limit: 500,
      });
      const read = readChart(minuteBars, sessionOpenMs);
      if (!read) continue;

      // Daily context, cached one fetch per symbol per day
      const cache = ctx.state.momoDailyContext ?? (ctx.state.momoDailyContext = {});
      let daily = cache[cand.symbol];
      if (!daily || daily.day !== etDayKey) {
        let blueSky: boolean | null = null;
        let overheadPct: number | null = null;
        try {
          const dailyBars = await alpaca.marketData.getBars(cand.symbol, "1Day", {
            start: new Date(nowMs - 370 * 86_400_000).toISOString(),
            limit: 300,
          });
          if (dailyBars.length >= 20) {
            const price = dailyBars[dailyBars.length - 1]!.c;
            const yearHigh = Math.max(...dailyBars.slice(-252).map(b => b.h));
            const sixtyHigh = Math.max(...dailyBars.slice(-60).map(b => b.h));
            blueSky = price >= yearHigh * 0.98;
            overheadPct = price > 0 ? Math.max(0, ((sixtyHigh - price) / price) * 100) : null;
          }
        } catch {
          // keep nulls — daily context is enrichment, not a gate
        }
        daily = { day: etDayKey, blueSky, overheadPct };
        cache[cand.symbol] = daily;
      }
      read.blueSky = daily.blueSky;
      read.overheadPct = daily.overheadPct;
      charts[cand.symbol] = read;
    } catch (e) {
      ctx.log("MomoScanner", "chart_read_error", { symbol: cand.symbol, error: String(e).slice(0, 120) });
    }
  }
  ctx.state.momoCharts = charts;

  // Prune stale daily-context entries
  if (ctx.state.momoDailyContext) {
    for (const sym of Object.keys(ctx.state.momoDailyContext)) {
      if (ctx.state.momoDailyContext[sym]!.day !== etDayKey) delete ctx.state.momoDailyContext[sym];
    }
  }

  ctx.log("MomoScanner", "momo_watchlist", {
    session: premarket ? "premarket" : "regular",
    count: candidates.length,
    setups: Object.entries(charts)
      .filter(([, r]) => r.setup !== "NONE")
      .map(([s, r]) => `${s}:${r.setup}`)
      .join(",") || "none",
    top3: candidates
      .slice(0, 3)
      .map(c => `${c.symbol} +${c.changePct.toFixed(1)}% rvol ${c.rvol.toFixed(1)}x`)
      .join(", "),
  });
}

/**
 * Gather signals from StockTwits trending symbols.
 */
export async function gatherStockTwits(ctx: HarnessContext): Promise<Signal[]> {
  const signals: Signal[] = [];
  const sourceWeight = SOURCE_CONFIG.weights.stocktwits;

  const stocktwitsHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const fetchWithRetry = async (url: string, maxRetries = 3): Promise<Response | null> => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(url, { headers: stocktwitsHeaders });
        if (res.ok) return res;
        if (res.status === 403) {
          await sleep(1000 * Math.pow(2, i));
          continue;
        }
        return null;
      } catch {
        await sleep(1000 * Math.pow(2, i));
      }
    }
    return null;
  };

  try {
    const trendingRes = await fetchWithRetry("https://api.stocktwits.com/api/2/trending/symbols.json");
    if (!trendingRes) {
      ctx.log("StockTwits", "cloudflare_blocked", {
        message: "StockTwits API blocked by Cloudflare - using Reddit only"
      });
      return [];
    }
    const trendingData = await trendingRes.json() as { symbols?: Array<{ symbol: string }> };
    const trending = trendingData.symbols || [];

    for (const sym of trending.slice(0, 15)) {
      try {
        const streamRes = await fetchWithRetry(`https://api.stocktwits.com/api/2/streams/symbol/${sym.symbol}.json?limit=30`);
        if (!streamRes) continue;
        const streamData = await streamRes.json() as { messages?: Array<{ entities?: { sentiment?: { basic?: string } }; created_at?: string }> };
        const messages = streamData.messages || [];

        let bullish = 0, bearish = 0, totalTimeDecay = 0;
        for (const msg of messages) {
          const sentiment = msg.entities?.sentiment?.basic;
          const msgTime = new Date(msg.created_at || Date.now()).getTime() / 1000;
          const timeDecay = calculateTimeDecay(msgTime);
          totalTimeDecay += timeDecay;

          if (sentiment === "Bullish") bullish += timeDecay;
          else if (sentiment === "Bearish") bearish += timeDecay;
        }

        const total = messages.length;
        const effectiveTotal = totalTimeDecay || 1;
        const score = effectiveTotal > 0 ? (bullish - bearish) / effectiveTotal : 0;
        const avgFreshness = total > 0 ? totalTimeDecay / total : 0;

        if (total >= 5) {
          const weightedSentiment = score * sourceWeight * avgFreshness;

          signals.push({
            symbol: sym.symbol,
            source: "stocktwits",
            source_detail: "stocktwits_trending",
            sentiment: weightedSentiment,
            raw_sentiment: score,
            volume: total,
            bullish: Math.round(bullish),
            bearish: Math.round(bearish),
            freshness: avgFreshness,
            source_weight: sourceWeight,
            reason: `StockTwits: ${Math.round(bullish)}B/${Math.round(bearish)}b (${(score * 100).toFixed(0)}%) [fresh:${(avgFreshness * 100).toFixed(0)}%]`,
            timestamp: Date.now(),
          });
        }

        await sleep(200);
      } catch {
        continue;
      }
    }
  } catch (error) {
    ctx.log("StockTwits", "error", { message: String(error) });
  }

  return signals;
}


/**
 * Gather signals from crypto markets based on momentum.
 */
export async function gatherCrypto(ctx: HarnessContext): Promise<Signal[]> {
  if (!ctx.state.config.crypto_enabled) return [];

  const signals: Signal[] = [];
  const symbols = ctx.state.config.crypto_symbols || ["BTC/USD", "ETH/USD", "SOL/USD"];
  const alpaca = createAlpacaProviders(ctx.env);

  for (const symbol of symbols) {
    try {
      const snapshot = await alpaca.marketData.getCryptoSnapshot(symbol);
      if (!snapshot) continue;

      const price = snapshot.latest_trade?.price || 0;
      const prevClose = snapshot.prev_daily_bar?.c || 0;

      if (!price || !prevClose) continue;

      const momentum = ((price - prevClose) / prevClose) * 100;
      const threshold = ctx.state.config.crypto_momentum_threshold || 2.0;
      const hasSignificantMove = Math.abs(momentum) >= threshold;
      const isBullish = momentum > 0;

      const rawSentiment = hasSignificantMove && isBullish ? Math.min(Math.abs(momentum) / 5, 1) : 0.1;

      signals.push({
        symbol,
        source: "crypto",
        source_detail: "crypto_momentum",
        sentiment: rawSentiment,
        raw_sentiment: rawSentiment,
        volume: snapshot.daily_bar?.v || 0,
        freshness: 1.0,
        source_weight: 0.8,
        reason: `Crypto: ${momentum >= 0 ? '+' : ''}${momentum.toFixed(2)}% (24h)`,
        bullish: isBullish ? 1 : 0,
        bearish: isBullish ? 0 : 1,
        isCrypto: true,
        momentum,
        price,
        timestamp: Date.now(),
      });

      await sleep(200);
    } catch (error) {
      ctx.log("Crypto", "error", { symbol, message: String(error) });
    }
  }

  ctx.log("Crypto", "gathered_signals", { count: signals.length });
  return signals;
}

/**
 * Gather momentum signals from Solana DEXs via DexScreener.
 * Finds tokens aged 3-14 days with proven momentum (not brand new rugs).
 */
export async function gatherDexMomentum(ctx: HarnessContext): Promise<void> {
  if (!ctx.state.config.dex_enabled) return;

  // Scan interval is now controlled by the alarm handler (dex_scan_interval_ms)
  // No rate limiting here - caller decides when to scan

  try {
    const dexScreener = createDexScreenerProvider();

    // Multi-chain discovery (Director 2026-08-03): scan each enabled chain and
    // tag signals so per-chain expectancy (Solana memes vs Robinhood memes) is
    // computable from the trade ledger.
    const chains = ctx.state.config.dex_chains ?? ["solana"];
    const findMomentumOptionsFor = (chain: string) => ({
      chain,
      // Multi-tier system config
      // Micro-spray (30min-2h) [TOGGLE]
      microSprayEnabled: ctx.state.config.dex_microspray_enabled ?? false,
      microSprayMinAgeMinutes: 30,
      microSprayMaxAgeHours: 2,
      microSprayMinLiquidity: 10000,
      // Breakout (2-6h) [TOGGLE]
      breakoutEnabled: ctx.state.config.dex_breakout_enabled ?? false,
      breakoutMinAgeHours: 2,
      breakoutMaxAgeHours: 6,
      breakoutMinLiquidity: 15000,
      breakoutMin5mPump: ctx.state.config.dex_breakout_min_5m_pump ?? 50,
      // Lottery (current working tier)
      lotteryEnabled: ctx.state.config.dex_lottery_enabled ?? true,
      lotteryMinAgeHours: ctx.state.config.dex_lottery_min_age_hours ?? 1,
      lotteryMaxAgeHours: ctx.state.config.dex_lottery_max_age_hours ?? 6,
      lotteryMinLiquidity: ctx.state.config.dex_lottery_min_liquidity ?? 15000,
      lotteryMinVolume: 5000,
      // Early tier
      earlyMinAgeDays: ctx.state.config.dex_early_min_age_days ?? 0.25,
      earlyMaxAgeDays: ctx.state.config.dex_early_max_age_days ?? 3,
      earlyMinLiquidity: ctx.state.config.dex_early_min_liquidity ?? 30000,
      earlyMinLegitimacyScore: ctx.state.config.dex_early_min_legitimacy ?? 40,
      // Established tier
      establishedMinAgeDays: ctx.state.config.dex_established_min_age_days ?? ctx.state.config.dex_min_age_days ?? 3,
      establishedMaxAgeDays: ctx.state.config.dex_established_max_age_days ?? ctx.state.config.dex_max_age_days ?? 14,
      establishedMinLiquidity: ctx.state.config.dex_established_min_liquidity ?? ctx.state.config.dex_min_liquidity ?? 50000,
      // Shared filters
      minVolume24h: ctx.state.config.dex_min_volume_24h,
      minPriceChange24h: ctx.state.config.dex_min_price_change,
    });

    const signals: Awaited<ReturnType<typeof dexScreener.findMomentumTokens>> = [];
    const chainStats: Record<string, { sourced: number; qualified: number }> = {};
    for (const chain of chains) {
      try {
        const chainSignals = await dexScreener.findMomentumTokens(findMomentumOptionsFor(chain));
        signals.push(...chainSignals);
        chainStats[chain] = dexScreener.lastScanStats ?? { sourced: 0, qualified: chainSignals.length };
      } catch (e) {
        chainStats[chain] = { sourced: 0, qualified: 0 };
        ctx.log("DexMomentum", "chain_scan_error", { chain, error: String(e).slice(0, 120) });
      }
    }
    ctx.state.dexChainScanStats = { chains: chainStats, updatedAt: Date.now() };
    // Cross-chain fairness: one ranking by momentum score
    signals.sort((a, b) => b.momentumScore - a.momentumScore);

    // Don't preserve stale signals for open positions.
    // When a token falls off DexScreener trending, the missing signal triggers
    // the lost_momentum exit path (missedScans counter) which cuts losers fast at -1%.
    // Prices for open positions come from Jupiter Price API + lastKnownPrice cache.
    const openPositionAddresses = new Set(Object.keys(ctx.state.dexPositions));
    const newSignalAddresses = new Set(signals.map(s => s.tokenAddress));
    const droppedPositions = [...openPositionAddresses].filter(addr => !newSignalAddresses.has(addr));
    if (droppedPositions.length > 0) {
      ctx.log("DexMomentum", "signals_dropped_for_positions", {
        dropped: droppedPositions.map(addr => ctx.state.dexPositions[addr]?.symbol || addr.slice(0, 8)),
        reason: "Token fell off trending - lost_momentum exit will evaluate",
      });
    }

    ctx.state.dexSignals = signals;

    // Add to signalCache so they show in dashboard active signals
    const now = Date.now();
    const dexAsSignals: Signal[] = signals.map(s => ({
      symbol: s.symbol,
      source: "dexscreener",
      source_detail: `dex_${s.dexId}`,
      sentiment: Math.min(1, s.momentumScore / 100), // Normalize to 0-1
      raw_sentiment: s.momentumScore / 100,
      volume: s.volume24h,
      freshness: 1.0, // Fresh scan
      source_weight: 0.8, // High weight for momentum signals
      reason: `DEX ${s.tier === 'early' ? '🌱' : '🌳'} +${s.priceChange24h.toFixed(0)}%/24h +${s.priceChange6h.toFixed(0)}%/6h, $${Math.round(s.liquidity).toLocaleString()} liq, ${s.ageDays.toFixed(1)}d, legit:${s.legitimacyScore}`,
      timestamp: now,
      isCrypto: true,
      momentum: s.priceChange24h / 100,
      price: s.priceUsd,
    }));

    // Merge with existing signals (remove old DEX signals first)
    ctx.state.signalCache = [
      ...ctx.state.signalCache.filter(s => s.source !== "dexscreener"),
      ...dexAsSignals,
    ];

    ctx.log("DexMomentum", "scan_complete", {
      found: signals.length,
      addedToSignals: dexAsSignals.length,
      top3: signals.slice(0, 3).map(s => ({
        symbol: s.symbol,
        priceChange24h: s.priceChange24h.toFixed(1) + "%",
        liquidity: "$" + Math.round(s.liquidity).toLocaleString(),
        momentumScore: s.momentumScore.toFixed(1),
      })),
    });
  } catch (error) {
    ctx.log("DexMomentum", "scan_error", { error: String(error) });
  }
}
