/**
 * DexScreener API Provider
 *
 * Fetches trending Solana tokens for momentum trading.
 * Filters for tokens aged 3-14 days with proven momentum.
 */

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string; label?: string }>;
    socials?: Array<{ url: string; type: string }>;
  };
}

export interface DexTokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
  links?: Array<{ url: string; type?: string; label?: string }>;
}

export interface DexMomentumSignal {
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  name: string;
  priceUsd: number;
  priceChange24h: number;
  priceChange1h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  ageHours: number;
  ageDays: number;
  buyRatio24h: number; // buys / (buys + sells)
  momentumScore: number;
  dexId: string;
  url: string;
}

const DEXSCREENER_BASE = "https://api.dexscreener.com";

export class DexScreenerProvider {
  private rateLimitDelay = 1100; // ~55 requests/min (under 60 limit)
  private lastRequest = 0;

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - elapsed));
    }
    this.lastRequest = Date.now();
  }

  /**
   * Get latest token profiles (newly listed/updated)
   */
  async getLatestProfiles(chain: string = "solana"): Promise<DexTokenProfile[]> {
    await this.throttle();

    const res = await fetch(`${DEXSCREENER_BASE}/token-profiles/latest/v1`);
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);

    const profiles: DexTokenProfile[] = await res.json();
    return profiles.filter(p => p.chainId === chain);
  }

  /**
   * Get token pair data by address
   */
  async getTokenPairs(chain: string, tokenAddress: string): Promise<DexPair[]> {
    await this.throttle();

    const res = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${chain}/${tokenAddress}`);
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);

    return res.json();
  }

  /**
   * Get multiple tokens at once (comma-separated, max 30)
   */
  async getMultipleTokens(chain: string, addresses: string[]): Promise<DexPair[]> {
    await this.throttle();

    const joined = addresses.slice(0, 30).join(",");
    const res = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${chain}/${joined}`);
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);

    return res.json();
  }

  /**
   * Search for tokens by query
   */
  async search(query: string): Promise<{ pairs: DexPair[] }> {
    await this.throttle();

    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);

    return res.json();
  }

  /**
   * Get top boosted tokens (paid promotions - use with caution)
   */
  async getTopBoosts(): Promise<DexTokenProfile[]> {
    await this.throttle();

    const res = await fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`);
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);

    return res.json();
  }

  /**
   * Get trending/top pairs on Solana using orders endpoint
   */
  async getTrendingPairs(): Promise<DexPair[]> {
    await this.throttle();

    // Use the token-boosts endpoint to find tokens getting attention
    const boostsRes = await fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`);
    if (!boostsRes.ok) return [];

    const boosts: DexTokenProfile[] = await boostsRes.json();
    const solanaBoosts = boosts.filter(b => b.chainId === "solana").slice(0, 30);

    if (solanaBoosts.length === 0) return [];

    // Get pair data for boosted tokens
    const addresses = solanaBoosts.map(b => b.tokenAddress);
    return this.getMultipleTokens("solana", addresses);
  }

  /**
   * Find Solana tokens with momentum (3-14 days old, good volume)
   * This is the main method for gem hunting.
   * Uses multiple data sources: boosts, profiles, and searches.
   */
  async findMomentumTokens(options: {
    minAgeDays?: number;
    maxAgeDays?: number;
    minLiquidity?: number;
    minVolume24h?: number;
    minPriceChange24h?: number;
  } = {}): Promise<DexMomentumSignal[]> {
    const {
      minAgeDays = 3,
      maxAgeDays = 14,
      minLiquidity = 50000,
      minVolume24h = 10000,
      minPriceChange24h = 5,
    } = options;

    // Gather pairs from multiple sources for better coverage
    const allPairs: DexPair[] = [];
    const seenAddresses = new Set<string>();

    // Source 1: Trending/boosted tokens
    try {
      const trendingPairs = await this.getTrendingPairs();
      for (const pair of trendingPairs) {
        if (!seenAddresses.has(pair.baseToken.address)) {
          seenAddresses.add(pair.baseToken.address);
          allPairs.push(pair);
        }
      }
    } catch (e) {
      console.error("Failed to fetch trending:", e);
    }

    // Source 2: Latest profiles (tokens updating their info = active projects)
    try {
      const profiles = await this.getLatestProfiles("solana");
      if (profiles.length > 0) {
        const addresses = profiles
          .map(p => p.tokenAddress)
          .filter(a => !seenAddresses.has(a))
          .slice(0, 30);

        if (addresses.length > 0) {
          const pairs = await this.getMultipleTokens("solana", addresses);
          for (const pair of pairs) {
            if (!seenAddresses.has(pair.baseToken.address)) {
              seenAddresses.add(pair.baseToken.address);
              allPairs.push(pair);
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to fetch profiles:", e);
    }

    // Source 3: Search for trending terms
    const searchTerms = ["pump", "moon", "sol", "meme"];
    for (const term of searchTerms.slice(0, 2)) {
      try {
        const searchResult = await this.search(term);
        const solanaPairs = searchResult.pairs
          .filter(p => p.chainId === "solana")
          .filter(p => !seenAddresses.has(p.baseToken.address))
          .slice(0, 10);

        for (const pair of solanaPairs) {
          seenAddresses.add(pair.baseToken.address);
          allPairs.push(pair);
        }
      } catch (e) {
        console.error(`Failed search for ${term}:`, e);
      }
    }

    const now = Date.now();
    const signals: DexMomentumSignal[] = [];

    // Debug stats
    let stats = { total: 0, noDate: 0, tooNew: 0, tooOld: 0, lowLiq: 0, lowVol: 0, negMom: 0, passed: 0 };

    for (const pair of allPairs) {
      stats.total++;

      // Skip non-Solana
      if (pair.chainId !== "solana") continue;

      // Skip if no creation date
      if (!pair.pairCreatedAt) {
        stats.noDate++;
        continue;
      }

      // Calculate age
      const ageMs = now - pair.pairCreatedAt;
      const ageHours = ageMs / (1000 * 60 * 60);
      const ageDays = ageHours / 24;

      // Age filter
      if (ageDays < minAgeDays) {
        stats.tooNew++;
        continue;
      }
      if (ageDays > maxAgeDays) {
        stats.tooOld++;
        continue;
      }

      // Liquidity filter
      const liquidity = pair.liquidity?.usd || 0;
      if (liquidity < minLiquidity) {
        stats.lowLiq++;
        continue;
      }

      // Volume filter
      const volume24h = pair.volume?.h24 || 0;
      if (volume24h < minVolume24h) {
        stats.lowVol++;
        continue;
      }

      // Price change filter (must be positive momentum)
      const priceChange24h = pair.priceChange?.h24 || 0;
      if (priceChange24h < minPriceChange24h) {
        stats.negMom++;
        continue;
      }

      stats.passed++;

      // Calculate buy ratio (bullish signal)
      const buys24h = pair.txns?.h24?.buys || 0;
      const sells24h = pair.txns?.h24?.sells || 0;
      const totalTxns = buys24h + sells24h;
      const buyRatio24h = totalTxns > 0 ? buys24h / totalTxns : 0.5;

      // Calculate momentum score (weighted combination)
      const momentumScore = this.calculateMomentumScore({
        priceChange24h,
        priceChange1h: pair.priceChange?.h1 || 0,
        volume24h,
        liquidity,
        buyRatio24h,
        ageDays,
      });

      signals.push({
        symbol: pair.baseToken.symbol,
        tokenAddress: pair.baseToken.address,
        pairAddress: pair.pairAddress,
        name: pair.baseToken.name,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        priceChange24h,
        priceChange1h: pair.priceChange?.h1 || 0,
        volume24h,
        liquidity,
        marketCap: pair.marketCap || pair.fdv || 0,
        ageHours,
        ageDays,
        buyRatio24h,
        momentumScore,
        dexId: pair.dexId,
        url: pair.url,
      });
    }

    // Log filter stats for debugging
    console.log("[DexScreener] Filter stats:", JSON.stringify(stats));

    // Sort by momentum score descending
    return signals.sort((a, b) => b.momentumScore - a.momentumScore);
  }

  private calculateMomentumScore(params: {
    priceChange24h: number;
    priceChange1h: number;
    volume24h: number;
    liquidity: number;
    buyRatio24h: number;
    ageDays: number;
  }): number {
    const { priceChange24h, priceChange1h, volume24h, liquidity, buyRatio24h, ageDays } = params;

    // Price momentum (0-40 points)
    const priceScore = Math.min(40, priceChange24h / 2.5);

    // Recent momentum - 1h price change (0-20 points)
    const recentScore = Math.min(20, Math.max(0, priceChange1h));

    // Volume health (0-15 points)
    const volumeRatio = volume24h / Math.max(liquidity, 1);
    const volumeScore = Math.min(15, volumeRatio * 5);

    // Buy pressure (0-15 points)
    const buyScore = (buyRatio24h - 0.5) * 30; // -15 to +15

    // Age sweetspot bonus (0-10 points) - prefer 5-10 day old tokens
    const idealAge = 7;
    const ageDeviation = Math.abs(ageDays - idealAge);
    const ageScore = Math.max(0, 10 - ageDeviation * 2);

    return Math.max(0, priceScore + recentScore + volumeScore + buyScore + ageScore);
  }
}

export function createDexScreenerProvider(): DexScreenerProvider {
  return new DexScreenerProvider();
}
