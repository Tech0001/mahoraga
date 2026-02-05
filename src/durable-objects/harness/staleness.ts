/**
 * Staleness Analysis Module
 *
 * Analyzes if a position is going stale (losing momentum) and should be exited.
 * Uses a multi-factor scoring system based on:
 * - Time held (longer = more stale)
 * - Price action (negative P&L adds staleness)
 * - Social volume decay (dropping mentions = fading interest)
 */

import type { HarnessContext } from "./context";

/**
 * Result of staleness analysis
 */
export interface StalenessResult {
  isStale: boolean;
  reason: string;
  staleness_score: number;
}

/**
 * Analyze if a position is going stale
 *
 * Staleness scoring (max 100 points):
 * - Time-based: up to 40 points for holding past max days
 * - Price action: up to 30 points for negative P&L
 * - Social volume decay: up to 30 points for dropping mentions
 *
 * Position is marked stale if:
 * - Score >= 70, OR
 * - Held past max days with gain below threshold
 *
 * @param ctx - Harness context
 * @param symbol - Stock symbol
 * @param currentPrice - Current price
 * @param currentSocialVolume - Current social mention volume
 */
export function analyzeStaleness(
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

  // Don't analyze staleness before minimum hold period
  if (holdHours < ctx.state.config.stale_min_hold_hours) {
    return { isStale: false, reason: `Too early (${holdHours.toFixed(1)}h)`, staleness_score: 0 };
  }

  let stalenessScore = 0;

  // Time-based scoring (max 40 points)
  // Full points at max_hold_days, partial points between mid and max
  if (holdDays >= ctx.state.config.stale_max_hold_days) {
    stalenessScore += 40;
  } else if (holdDays >= ctx.state.config.stale_mid_hold_days) {
    stalenessScore += 20 * (holdDays - ctx.state.config.stale_mid_hold_days) /
      (ctx.state.config.stale_max_hold_days - ctx.state.config.stale_mid_hold_days);
  }

  // Price action scoring (max 30 points)
  // Negative P&L adds points, flat/small gain at mid hold adds some points
  if (pnlPct < 0) {
    stalenessScore += Math.min(30, Math.abs(pnlPct) * 3);
  } else if (pnlPct < ctx.state.config.stale_mid_min_gain_pct && holdDays >= ctx.state.config.stale_mid_hold_days) {
    stalenessScore += 15;
  }

  // Social volume decay scoring (max 30 points)
  // Full points if volume dropped to decay threshold, partial for moderate drops
  const volumeRatio = entry.entry_social_volume > 0
    ? currentSocialVolume / entry.entry_social_volume
    : 1;
  if (volumeRatio <= ctx.state.config.stale_social_volume_decay) {
    stalenessScore += 30;
  } else if (volumeRatio <= 0.5) {
    stalenessScore += 15;
  }

  // Cap at 100
  stalenessScore = Math.min(100, stalenessScore);

  // Position is stale if score >= 70 OR held past max days without sufficient gain
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
