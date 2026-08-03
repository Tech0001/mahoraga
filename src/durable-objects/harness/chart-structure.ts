/**
 * Chart Structure Engine
 *
 * Reads bar data the way a momentum trader reads a chart: where price sits in
 * the session's structure (opening range, VWAP, high-of-day), whether recent
 * bars are building (tight flag, higher lows, volume on pushes) or breaking
 * down (lower highs compressing, VWAP lost, volume dying), plus daily-chart
 * context (blue sky vs overhead supply).
 *
 * One shared brain, three consumers:
 *  1. Pre-entry: classify the setup and pre-plan entry/stop levels
 *  2. Trigger: mechanical confirmation of that plan
 *  3. In-trade: continuous structural read of open positions for exits
 *
 * v0 rules are deliberately simple and journaled (2026-08-03); calibration
 * against the Director's chart reads tunes them.
 */

import type { Bar } from "../../providers/types";

export type SetupLabel =
  | "ORB" // at/near opening-range high with volume — breakout trigger armed
  | "OPEN_RECLAIM" // open spike -> dip -> climbing off the dip low = real momentum (Director's bread-and-butter)
  | "RECLAIM" // sessionless variant (24/7 DEX): rolling-window spike -> dip -> climb off the base
  | "FLAG" // tight consolidation near HOD after a leg up — continuation setup
  | "VWAP_HOLD" // pulled back to VWAP and holding with higher lows
  | "EXTENDED" // far above VWAP — chase risk, no fresh entry
  | "FADING" // lower highs off HOD — momentum bleeding out
  | "BREAKDOWN" // below VWAP and opening-range low — structure failed
  | "NONE";

export interface ChartRead {
  setup: SetupLabel;
  // Pre-planned levels (null when the setup offers no clean plan)
  trigger: number | null;
  stop: number | null;
  note: string;
  // Session structure
  vwap: number;
  hod: number;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  distFromVwapPct: number;
  distFromHodPct: number;
  higherLows: number;
  lowerHighs: number;
  // Recent bars carrying above-average volume (buyers actually participating)
  volumeExpanding: boolean;
  // Daily context (when daily bars provided)
  blueSky: boolean | null; // within 2% of / above 52-week high — no overhead supply
  overheadPct: number | null; // % up to the 60-day high (0 = at/above it)
  asOf: number;
}

const OPENING_RANGE_MINUTES = 5;

function sessionVwap(bars: Bar[]): number {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const typical = b.vw > 0 ? b.vw : (b.h + b.l + b.c) / 3;
    pv += typical * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : bars[bars.length - 1]?.c ?? 0;
}

/** Swing pivots on bar highs/lows with a 2-bar confirmation window. */
function pivots(bars: Bar[]): { swingHighs: number[]; swingLows: number[] } {
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const h = bars[i]!.h;
    const l = bars[i]!.l;
    if (h > bars[i - 1]!.h && h > bars[i - 2]!.h && h > bars[i + 1]!.h && h > bars[i + 2]!.h) {
      swingHighs.push(h);
    }
    if (l < bars[i - 1]!.l && l < bars[i - 2]!.l && l < bars[i + 1]!.l && l < bars[i + 2]!.l) {
      swingLows.push(l);
    }
  }
  return { swingHighs, swingLows };
}

function trailingCount(values: number[], rising: boolean): number {
  // Count consecutive rising (higher lows) or falling (lower highs) pivots
  // from the end of the series.
  let count = 0;
  for (let i = values.length - 1; i > 0; i--) {
    const up = values[i]! > values[i - 1]!;
    if (up === rising) count++;
    else break;
  }
  return count;
}

/**
 * Read intraday structure from 1-minute session bars (premarket included when
 * present). sessionOpenMs: epoch ms of the regular-session open, used for the
 * opening range; pass null during premarket (no OR yet).
 */
export function readChart(
  minuteBars: Bar[],
  sessionOpenMs: number | null,
  dailyBars?: Bar[]
): ChartRead | null {
  if (minuteBars.length < 5) return null;

  const last = minuteBars[minuteBars.length - 1]!;
  const price = last.c;
  const vwap = sessionVwap(minuteBars);
  const hod = Math.max(...minuteBars.map(b => b.h));

  let orHigh: number | null = null;
  let orLow: number | null = null;
  if (sessionOpenMs !== null) {
    const orBars = minuteBars.filter(b => {
      const t = new Date(b.t).getTime();
      return t >= sessionOpenMs && t < sessionOpenMs + OPENING_RANGE_MINUTES * 60_000;
    });
    if (orBars.length > 0) {
      orHigh = Math.max(...orBars.map(b => b.h));
      orLow = Math.min(...orBars.map(b => b.l));
    }
  }

  const { swingHighs, swingLows } = pivots(minuteBars.slice(-60));
  const higherLows = trailingCount(swingLows, true);
  const lowerHighs = trailingCount(swingHighs.map(v => -v), true); // falling highs

  const distFromVwapPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
  const distFromHodPct = hod > 0 ? ((price - hod) / hod) * 100 : 0;

  // Range contraction: last 5 bars' total range vs the prior 5 (flag tightness)
  const lastN = minuteBars.slice(-5);
  const priorN = minuteBars.slice(-10, -5);
  const rangeOf = (bs: Bar[]) => Math.max(...bs.map(b => b.h)) - Math.min(...bs.map(b => b.l));
  const contraction = priorN.length === 5 && rangeOf(priorN) > 0 ? rangeOf(lastN) / rangeOf(priorN) : 1;

  // Volume read: average of the last 3 bars vs the session average
  const avgVol = minuteBars.reduce((s, b) => s + b.v, 0) / minuteBars.length;
  const recentVol = lastN.slice(-3).reduce((s, b) => s + b.v, 0) / 3;
  const volumeExpanding = avgVol > 0 && recentVol > avgVol * 1.5;

  // Daily context
  let blueSky: boolean | null = null;
  let overheadPct: number | null = null;
  if (dailyBars && dailyBars.length >= 20) {
    const yearHigh = Math.max(...dailyBars.slice(-252).map(b => b.h));
    const sixtyDayHigh = Math.max(...dailyBars.slice(-60).map(b => b.h));
    blueSky = price >= yearHigh * 0.98;
    overheadPct = price > 0 ? Math.max(0, ((sixtyDayHigh - price) / price) * 100) : null;
  }

  // Open spike -> dip -> reclaim: the market-open pattern. Someone sees green
  // and wants in; premarket holders sell the spike; if price puts in a low and
  // climbs again, that reclaim is real momentum. Window: 6-45 min after open.
  let openReclaim: { stop: number; label: "OPEN_RECLAIM" | "RECLAIM" } | null = null;
  {
    // Session-anchored (stocks: the market-open spike) or rolling-window
    // (DEX, 24/7: the last hour's spike). Same pattern either way: spike,
    // real profit-taking dip, then climbing off the dip low = get in at the
    // bottom of the reversal, not the top of the recovery.
    let windowBars: Bar[] = [];
    let timeOk = false;
    if (sessionOpenMs !== null) {
      const minsSinceOpen = (new Date(last.t).getTime() - sessionOpenMs) / 60_000;
      timeOk = minsSinceOpen >= 6 && minsSinceOpen <= 45;
      windowBars = minuteBars.filter(b => new Date(b.t).getTime() >= sessionOpenMs);
    } else {
      windowBars = minuteBars.slice(-60);
      timeOk = windowBars.length >= 15;
    }
    if (timeOk && windowBars.length >= 6) {
      const spikeChunk = sessionOpenMs !== null
        ? windowBars.slice(0, Math.min(10, windowBars.length))
        : windowBars.slice(0, windowBars.length - 5); // spike anywhere before the last 5 bars
      const spikeHigh = Math.max(...spikeChunk.map(b => b.h));
      const spikeIdx = windowBars.findIndex(b => b.h === spikeHigh);
      const afterSpike = windowBars.slice(spikeIdx + 1);
      if (afterSpike.length >= 3) {
        const dipLow = Math.min(...afterSpike.map(b => b.l));
        const dipDepth = sessionOpenMs !== null ? 0.98 : 0.9; // DEX dips run deeper
        const dipped = dipLow <= spikeHigh * dipDepth;
        const closes = windowBars.slice(-3).map(b => b.c);
        const climbing = closes.length === 3 && closes[2]! > closes[1]! && closes[1]! > closes[0]!;
        const offLow = price >= dipLow * 1.01 && price <= spikeHigh * 1.02; // rebounding, not already blown past
        if (dipped && climbing && offLow && price >= vwap * 0.99) {
          openReclaim = { stop: dipLow, label: sessionOpenMs !== null ? "OPEN_RECLAIM" : "RECLAIM" };
        }
      }
    }
  }

  // Classification — order matters: failure states first, then entries.
  let setup: SetupLabel = "NONE";
  let trigger: number | null = null;
  let stop: number | null = null;
  let note = "";

  const belowOr = orLow !== null && price < orLow;
  if (price < vwap && belowOr) {
    setup = "BREAKDOWN";
    note = "below VWAP and opening-range low — structure failed";
  } else if (lowerHighs >= 2 && distFromHodPct < -3) {
    setup = "FADING";
    note = `${lowerHighs} lower highs off HOD — momentum bleeding (descending wedge risk)`;
  } else if (distFromVwapPct > 10) {
    setup = "EXTENDED";
    note = `${distFromVwapPct.toFixed(1)}% above VWAP — chase risk, wait for a base`;
  } else if (openReclaim) {
    setup = openReclaim.label;
    trigger = price; // reclaim already confirming — enter on detection
    stop = openReclaim.stop;
    note = `spike, dip, climbing off ${openReclaim.stop < 0.01 ? "$" + openReclaim.stop.toExponential(2) : "$" + openReclaim.stop.toFixed(2)} — momentum reclaim`;
  } else if (distFromHodPct > -5 && contraction < 0.5 && price >= vwap) {
    setup = "FLAG";
    trigger = Math.max(...lastN.map(b => b.h));
    stop = Math.min(...lastN.map(b => b.l));
    note = "tight flag near HOD above VWAP — buy the range break";
  } else if (orHigh !== null && price >= vwap && price >= orHigh * 0.99 && price <= orHigh * 1.02) {
    // NEAR the OR high, not merely above it — a midday chart far above its
    // opening range is not an opening-range breakout.
    setup = "ORB";
    trigger = orHigh;
    stop = orLow !== null ? Math.max(orLow, vwap * 0.99) : vwap * 0.99;
    note = volumeExpanding ? "at opening-range high with volume" : "at opening-range high, volume thin";
  } else if (price >= vwap && distFromVwapPct < 2 && higherLows >= 1) {
    setup = "VWAP_HOLD";
    trigger = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1]! : hod;
    stop = vwap * 0.985;
    note = "holding VWAP with higher lows — buy reclaim of last swing high";
  }

  // Plan sanity: a stop at or above the trigger is not a plan.
  if (trigger !== null && stop !== null && stop >= trigger) {
    trigger = null;
    stop = null;
    note += " (no clean risk level — plan withheld)";
  }

  return {
    setup,
    trigger,
    stop,
    note,
    vwap,
    hod,
    openingRangeHigh: orHigh,
    openingRangeLow: orLow,
    distFromVwapPct,
    distFromHodPct,
    higherLows,
    lowerHighs,
    volumeExpanding,
    blueSky,
    overheadPct,
    asOf: Date.now(),
  };
}

/**
 * In-trade structural exit read for an open position.
 * Returns an exit reason when the chart says leave, null to keep holding.
 */
export function structuralExitSignal(read: ChartRead, entryPrice: number, currentPrice: number): string | null {
  if (read.setup === "BREAKDOWN") return "structure_breakdown";
  if (read.setup === "FADING" && currentPrice <= entryPrice) return "fading_underwater";
  if (read.lowerHighs >= 3) return "descending_wedge";
  if (currentPrice < read.vwap * 0.97) return "vwap_lost";
  return null;
}
