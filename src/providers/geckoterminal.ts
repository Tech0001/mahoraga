/**
 * GeckoTerminal OHLCV Provider
 *
 * Free candle data for DEX pools (no API key), used to run the
 * chart-structure engine on DEX tokens: entries on reversal structure
 * instead of "green and trending" (which buys local tops), exits on
 * structural breakdown or blow-off extension.
 *
 * Free tier ~30 calls/min — throttled to ~2.2s between requests. Callers
 * fetch candles only for gate finalists and open positions (a handful per
 * scan), never for the whole discovery set.
 */

import type { Bar } from "./types";

const BASE = "https://api.geckoterminal.com/api/v2";

// DexScreener chainId -> GeckoTerminal network slug (verified live 2026-08-03)
const NETWORK_MAP: Record<string, string> = {
  solana: "solana",
  robinhood: "robinhood",
};

export class GeckoTerminalProvider {
  private lastRequest = 0;
  private rateLimitDelay = 2200;

  private async throttle(): Promise<void> {
    const wait = this.lastRequest + this.rateLimitDelay - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequest = Date.now();
  }

  /**
   * 1-minute candles for a pool, oldest-first, mapped to the shared Bar
   * shape so chart-structure's readChart consumes them directly.
   * Returns [] when the network/pool is unknown or the API fails.
   */
  async getMinuteBars(chain: string, poolAddress: string, limit = 120): Promise<Bar[]> {
    const network = NETWORK_MAP[chain];
    if (!network || !poolAddress) return [];

    await this.throttle();
    try {
      const res = await fetch(
        `${BASE}/networks/${network}/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute?aggregate=1&limit=${limit}`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
      };
      const list = data.data?.attributes?.ohlcv_list ?? [];
      // GeckoTerminal returns newest-first; readChart expects oldest-first.
      return list
        .slice()
        .reverse()
        .map(([ts, o, h, l, c, v]) => ({
          t: new Date(ts * 1000).toISOString(),
          o,
          h,
          l,
          c,
          v,
          n: 0,
          vw: 0, // typical-price fallback inside sessionVwap handles vw=0
        }));
    } catch {
      return [];
    }
  }
}

export function createGeckoTerminalProvider(): GeckoTerminalProvider {
  return new GeckoTerminalProvider();
}
