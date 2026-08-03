/**
 * TradingView Screener Provider
 *
 * Queries TradingView's public screener endpoint (the same JSON backend the
 * web screener uses) for momentum candidates with consolidated-tape stats:
 * change, volume, relative volume, float. This is an UNOFFICIAL endpoint —
 * no SLA, may change without notice — so it is a best-effort signal source
 * only. Execution and bars stay on Alpaca; nothing critical-path lives here.
 * Poll politely: one request per scan interval, never in a tight loop.
 */

const SCAN_URL = "https://scanner.tradingview.com/america/scan";

export interface MomoCandidate {
  symbol: string;
  exchange: string;
  price: number;
  changePct: number; // premarket_change during premarket, else session change
  volume: number; // premarket_volume during premarket, else session volume
  rvol: number; // volume vs 10-day average
  floatShares: number | null;
  dayHigh: number | null;
  nearHigh: boolean; // holding within 5% of the session high (RTH only)
  score: number;
  session: "premarket" | "regular";
}

export interface MomoScanParams {
  premarket: boolean;
  minChangePct: number;
  minRvol: number;
  minVolume: number;
  priceMin: number;
  priceMax: number;
  limit: number;
}

/**
 * Momentum score v0 (journal 2026-08-03): gap size weighted by participation,
 * with a bonus for names holding near their session high (the "green and has
 * action, not fading" read). Calibration sessions will tune this.
 */
function momoScore(changePct: number, volume: number, nearHigh: boolean): number {
  const participation = Math.log10(Math.max(volume, 10));
  return changePct * participation * (nearHigh ? 1.25 : 1);
}

export async function scanMomoCandidates(params: MomoScanParams): Promise<MomoCandidate[]> {
  const changeField = params.premarket ? "premarket_change" : "change";
  const volumeField = params.premarket ? "premarket_volume" : "volume";

  const body = {
    filter: [
      { left: changeField, operation: "greater", right: params.minChangePct },
      { left: volumeField, operation: "greater", right: params.minVolume },
      { left: "relative_volume_10d_calc", operation: "greater", right: params.minRvol },
      { left: "close", operation: "in_range", right: [params.priceMin, params.priceMax] },
      { left: "exchange", operation: "in_range", right: ["NYSE", "NASDAQ", "AMEX"] },
      { left: "is_primary", operation: "equal", right: true },
    ],
    columns: [
      "name",
      "exchange",
      "close",
      "change",
      "volume",
      "relative_volume_10d_calc",
      "float_shares_outstanding",
      "high",
      "premarket_change",
      "premarket_volume",
    ],
    sort: { sortBy: changeField, sortOrder: "desc" },
    range: [0, Math.max(1, Math.min(params.limit, 50))],
  };

  const response = await fetch(SCAN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`TradingView scan failed (${response.status})`);
  }

  const data = (await response.json()) as {
    totalCount?: number;
    data?: Array<{ s: string; d: unknown[] }>;
  };

  const out: MomoCandidate[] = [];
  for (const row of data.data ?? []) {
    const d = row.d;
    const num = (i: number): number | null =>
      typeof d[i] === "number" && Number.isFinite(d[i] as number) ? (d[i] as number) : null;

    const symbol = typeof d[0] === "string" ? (d[0] as string) : null;
    const price = num(2);
    if (!symbol || price === null) continue;

    const changePct = (params.premarket ? num(8) : num(3)) ?? 0;
    const volume = (params.premarket ? num(9) : num(4)) ?? 0;
    const dayHigh = num(7);
    const nearHigh = !params.premarket && dayHigh !== null && dayHigh > 0 && price >= dayHigh * 0.95;

    out.push({
      symbol,
      exchange: typeof d[1] === "string" ? (d[1] as string) : "",
      price,
      changePct,
      volume,
      rvol: num(5) ?? 0,
      floatShares: num(6),
      dayHigh,
      nearHigh,
      score: momoScore(changePct, volume, nearHigh),
      session: params.premarket ? "premarket" : "regular",
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
