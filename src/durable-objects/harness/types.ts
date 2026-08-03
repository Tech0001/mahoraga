/**
 * Types and interfaces for MahoragaHarness
 *
 * This file contains all type definitions used by the trading agent.
 */

import type { DexMomentumSignal } from "../../providers/dexscreener";

// ============================================================================
// CRISIS MODE TYPES - Black Swan Protection System
// ============================================================================

export type CrisisLevel = 0 | 1 | 2 | 3; // 0=Normal, 1=Elevated, 2=High Alert, 3=Full Crisis

export interface CrisisIndicators {
  // Volatility & Fear
  vix: number | null; // VIX index value (fear gauge)

  // Credit Markets
  highYieldSpread: number | null; // High yield spread in basis points
  yieldCurve2Y10Y: number | null; // 2Y/10Y Treasury spread (negative = inverted = recession)
  tedSpread: number | null; // TED spread (LIBOR - T-bill, banking stress)

  // Crypto (risk indicator, not safe haven)
  btcPrice: number | null; // BTC price
  btcWeeklyChange: number | null; // BTC % change over 7 days
  stablecoinPeg: number | null; // USDT price (should be ~$1.00)

  // Currency & Dollar
  dxy: number | null; // Dollar Index (spike = risk-off)
  usdJpy: number | null; // USD/JPY (yen carry trade unwind signal)

  // Banking Stress
  kre: number | null; // Regional Bank ETF price
  kreWeeklyChange: number | null; // Regional Bank ETF weekly % change

  // Precious Metals
  goldSilverRatio: number | null; // Gold/Silver ratio
  silverWeeklyChange: number | null; // Silver weekly % change (momentum)

  // Market Breadth
  stocksAbove200MA: number | null; // % of S&P 500 above 200-day MA

  // Fed & Liquidity (from FRED)
  fedBalanceSheet: number | null; // Fed balance sheet in trillions
  fedBalanceSheetChange: number | null; // Weekly change in Fed balance sheet

  lastUpdated: number; // Timestamp of last fetch
}

export interface CrisisState {
  level: CrisisLevel;
  indicators: CrisisIndicators;
  triggeredIndicators: string[]; // Which indicators are in crisis
  pausedUntil: number | null; // Trading paused until this timestamp
  lastLevelChange: number; // When crisis level last changed
  positionsClosedInCrisis: string[]; // Symbols closed due to crisis
  manualOverride: boolean; // User can manually enable/disable
}

// ============================================================================
// AGENT CONFIGURATION
// ============================================================================

export interface AgentConfig {
  // Polling intervals - how often the agent checks for new data
  data_poll_interval_ms: number; // [TUNE] Default: 30s. Lower = more API calls
  analyst_interval_ms: number; // [TUNE] Default: 120s. How often to run trading logic
  premarket_plan_window_minutes: number; // [TUNE] Plan when within N minutes of next_open (Alpaca clock)
  market_open_execute_window_minutes: number; // [TUNE] Execute the plan within N minutes after open

  // Momo scanner (TradingView screener data; informational lane, no trading)
  momo_scanner_enabled: boolean;
  momo_scan_interval_ms: number; // [TUNE] Politeness floor 15s; unofficial endpoint
  momo_min_change_pct: number; // [TUNE] Minimum gap/change % to qualify
  momo_min_rvol: number; // [TUNE] Minimum relative volume vs 10-day
  momo_min_volume: number; // [TUNE] Minimum session/premarket volume (shares)
  momo_price_min: number;
  momo_price_max: number;
  momo_watchlist_size: number;

  // Momentum lane execution (Alpaca paper; ships disabled until calibrated)
  momentum_trading_enabled: boolean;
  momentum_position_usd: number; // [TUNE] Dollar size per entry
  momentum_max_positions: number;
  momentum_daily_loss_cap_usd: number; // [TUNE] Lane halts for the day when breached
  momentum_time_exit_minutes: number; // [TUNE] Momo trades don't become bagholds
  momentum_take_profit_r: number; // [TUNE] Target = trigger + R x (trigger - stop)
  momentum_news_scalp_enabled: boolean; // A-catalyst open scalp play
  momentum_news_scalp_hold_seconds: number; // [TUNE] Sell into the open rush after N seconds
  momentum_news_scalp_min_gap_pct: number; // [TUNE] Minimum premarket gap to scalp
  dex_lottery_stagnation_minutes: number; // [TUNE] Lottery flat past N min = dead signal, free the slot (0=off)
  dex_loser_band_pct: number; // [TUNE] Exits within -N%..0 are churn noise, not losses (no loser lockout)
  dex_open_position_alarm_ms: number; // [TUNE] Alarm cadence while DEX positions are open
  dex_chains: string[]; // Chains to scan ("solana", "robinhood"); per-chain expectancy in ledger
  dex_structure_gate_enabled: boolean; // Require reversal structure (candles) before entry
  dex_structure_exits_enabled: boolean; // Structural exits: wedge/VWAP-lost/breakdown + sell-into-strength
  dex_structure_top_vwap_pct: number; // [TUNE] "Vertical" = this % above VWAP for structure_top exits
  dex_cap_override_enabled: boolean; // RECLAIM + expanding volume can override the 1h cap (Doom-class runners)
  dex_cap_override_max_1h_pct: number; // [TUNE] Hard ceiling — above this nothing overrides

  // Position limits - risk management basics
  max_position_value: number; // [TUNE] Max $ per position
  max_positions: number; // [TUNE] Max concurrent positions
  min_sentiment_score: number; // [TUNE] Min sentiment to consider buying (0-1)
  min_analyst_confidence: number; // [TUNE] Min LLM confidence to execute (0-1)
  sell_sentiment_threshold: number; // [TUNE] Sentiment below this triggers sell review

  // Risk management - take profit and stop loss
  take_profit_pct: number; // [TUNE] Take profit at this % gain
  stop_loss_pct: number; // [TUNE] Stop loss at this % loss
  position_size_pct_of_cash: number; // [TUNE] % of cash per trade
  starting_equity: number; // [TUNE] Starting equity for P&L calculation

  // Stale position management - exit positions that have lost momentum
  stale_position_enabled: boolean;
  stale_min_hold_hours: number; // [TUNE] Min hours before checking staleness
  stale_max_hold_days: number; // [TUNE] Force exit after this many days
  stale_min_gain_pct: number; // [TUNE] Required gain % to hold past max days
  stale_mid_hold_days: number;
  stale_mid_min_gain_pct: number;
  stale_social_volume_decay: number; // [TUNE] Exit if volume drops to this % of entry
  stale_no_mentions_hours: number; // [TUNE] Exit if no mentions for N hours

  // LLM configuration
  llm_provider: "openai-raw" | "ai-sdk" | "cloudflare-gateway"; // [TUNE] Provider: openai-raw, ai-sdk, cloudflare-gateway
  llm_model: string; // [TUNE] Model for quick research (gpt-4o-mini)
  llm_analyst_model: string; // [TUNE] Model for deep analysis (gpt-4o)
  llm_max_tokens: number;
  llm_min_hold_minutes: number; // [TUNE] Min minutes before LLM can recommend sell (default: 30)

  // Options trading - trade options instead of shares for high-conviction plays
  options_enabled: boolean; // [TOGGLE] Enable/disable options trading
  options_min_confidence: number; // [TUNE] Higher threshold for options (riskier)
  options_max_pct_per_trade: number;
  options_max_total_exposure: number;
  options_min_dte: number; // [TUNE] Minimum days to expiration
  options_max_dte: number; // [TUNE] Maximum days to expiration
  options_target_delta: number; // [TUNE] Target delta (0.3-0.5 typical)
  options_min_delta: number;
  options_max_delta: number;
  options_stop_loss_pct: number; // [TUNE] Options stop loss (wider than stocks)
  options_take_profit_pct: number; // [TUNE] Options take profit (higher targets)
  options_max_positions: number;

  // Crypto trading - 24/7 momentum-based crypto trading
  crypto_enabled: boolean; // [TOGGLE] Enable/disable crypto trading
  crypto_symbols: string[]; // [TUNE] Which cryptos to trade (BTC/USD, etc.)
  crypto_momentum_threshold: number; // [TUNE] Min % move to trigger signal
  crypto_max_position_value: number;
  crypto_take_profit_pct: number;
  crypto_stop_loss_pct: number;

  // Custom ticker blacklist - user-defined symbols to never trade (e.g., insider trading restrictions)
  ticker_blacklist: string[];

  // Stock trading toggle - disable to trade crypto only (avoids PDT rules)
  stocks_enabled: boolean; // [TOGGLE] Enable/disable stock trading

  // Allowed exchanges - only trade stocks listed on these exchanges (avoids OTC data issues)
  allowed_exchanges: string[];

  // DEX momentum trading - hunt for gems on Solana DEXs
  dex_enabled: boolean; // [TOGGLE] Enable/disable DEX gem hunting
  dex_starting_balance_sol: number; // [TUNE] Starting paper trading balance in SOL

  // Multi-tier system with toggles
  // Micro-spray (30min-2h) - ultra-tiny bets to catch early movers [TOGGLE OFF by default]
  dex_microspray_enabled: boolean; // [TOGGLE] Enable micro-spray tier
  dex_microspray_position_sol: number; // [TUNE] Ultra-tiny position (default 0.005 SOL)
  dex_microspray_max_positions: number; // [TUNE] Max concurrent micro-spray positions (default 10)
  // Breakout (2-6h) - detect rapid 5-min pumps [TOGGLE OFF by default]
  dex_breakout_enabled: boolean; // [TOGGLE] Enable breakout tier
  dex_breakout_min_5m_pump: number; // [TUNE] Minimum 5-min pump % to trigger (default 50)
  dex_breakout_position_sol: number; // [TUNE] Position size (default 0.015 SOL)
  dex_breakout_max_positions: number; // [TUNE] Max concurrent breakout positions (default 5)
  // Lottery (1-6h) - current working tier
  dex_lottery_enabled: boolean; // [TOGGLE] Enable lottery tier
  dex_lottery_min_age_hours: number; // [TUNE] Min age in hours (default 1)
  dex_lottery_max_age_hours: number; // [TUNE] Max age in hours (default 6)
  dex_lottery_min_liquidity: number; // [TUNE] Min liquidity (default $15k)
  dex_lottery_position_sol: number; // [TUNE] Fixed tiny position size in SOL (default 0.02)
  dex_lottery_max_positions: number; // [TUNE] Max concurrent lottery positions (default 5)
  dex_lottery_trailing_activation: number; // [TUNE] Auto-enable trailing stop at this gain % (default 100)
  dex_max_entry_1h_change?: number; // [TUNE] Reject entries already up more than this % on the 1h candle (overextension cap, default 150)
  // Tier 1: Early Gems (6h-3 days)
  dex_early_min_age_days: number; // [TUNE] Tier 1: Min age (default 0.25 = 6 hours)
  dex_early_max_age_days: number; // [TUNE] Tier 1: Max age (default 3 days)
  dex_early_min_liquidity: number; // [TUNE] Tier 1: Min liquidity (default $30k)
  dex_early_min_legitimacy: number; // [TUNE] Tier 1: Min legitimacy score 0-100 (default 40)
  dex_early_position_size_pct: number; // [TUNE] Tier 1: Position size multiplier (default 50 = half normal size)
  // Tier 2: Established (3-14 days)
  dex_established_min_age_days: number; // [TUNE] Tier 2: Min age (default 3 days)
  dex_established_max_age_days: number; // [TUNE] Tier 2: Max age (default 14 days)
  dex_established_min_liquidity: number; // [TUNE] Tier 2: Min liquidity (default $50k)

  // Legacy age config (fallback if tier-specific not set)
  dex_min_age_days: number; // [TUNE] Minimum token age in days (filter out brand new rugs)
  dex_max_age_days: number; // [TUNE] Maximum token age in days (before CEX listing)
  dex_min_liquidity: number; // [TUNE] Minimum liquidity in USD
  dex_min_volume_24h: number; // [TUNE] Minimum 24h volume
  dex_min_price_change: number; // [TUNE] Minimum 24h price change %
  dex_max_position_sol: number; // [TUNE] Max SOL per position (capped)
  dex_position_size_pct: number; // [TUNE] Position size as % of balance (0-100)
  dex_take_profit_pct: number; // [TUNE] Take profit %
  dex_stop_loss_pct: number; // [TUNE] Stop loss % (established tier default)
  dex_lottery_stop_loss_pct?: number; // [TUNE] Stop loss % for lottery tier
  dex_microspray_stop_loss_pct?: number; // [TUNE] Stop loss % for microspray tier
  dex_breakout_stop_loss_pct?: number; // [TUNE] Stop loss % for breakout tier
  dex_early_stop_loss_pct?: number; // [TUNE] Stop loss % for early tier
  dex_max_positions: number; // [TUNE] Max concurrent DEX positions
  dex_slippage_model: "none" | "conservative" | "realistic"; // [TUNE] Slippage simulation model
  dex_gas_fee_sol: number; // [TUNE] Simulated gas fee per trade in SOL (default: 0.005)
  dex_scan_interval_ms?: number; // [TUNE] How often to run DexScreener discovery scan (default: 60000 = 60s)

  // Circuit breaker - pause trading after multiple stop losses
  dex_circuit_breaker_losses: number; // [TUNE] Number of stop losses to trigger circuit breaker
  dex_circuit_breaker_window_hours: number; // [TUNE] Time window to count stop losses
  dex_circuit_breaker_pause_hours: number; // [TUNE] How long to pause after circuit breaker triggers

  // Maximum drawdown protection
  dex_max_drawdown_pct: number; // [TUNE] Max drawdown % before pausing trading

  // Position concentration limit
  dex_max_single_position_pct: number; // [TUNE] Max % of total DEX portfolio in one token (default: 40)

  // Stop loss cooldown - prevent re-entry after stop loss (price-based primary, time-based fallback)
  dex_stop_loss_cooldown_hours: number; // [TUNE] Fallback time cooldown if price data unavailable
  dex_reentry_recovery_pct: number; // [TUNE] Allow re-entry when price is X% above exit price
  dex_reentry_min_momentum: number; // [TUNE] OR allow re-entry when momentum score exceeds this
  dex_breaker_min_cooldown_minutes: number; // [TUNE] Minimum pause before circuit breaker can clear
  dex_min_cooldown_minutes?: number; // [TUNE] Minimum cooldown even for high momentum tokens (default: 30)
  dex_max_consecutive_losses?: number; // [TUNE] Block re-entry after this many consecutive losses (default: 2)

  // Proactive take profit - lock in gains at target levels
  dex_take_profit_enabled?: boolean; // [TOGGLE] Enable proactive take profit (default: FALSE - let runners run)
  dex_time_based_profit_pct?: number; // [TUNE] Min profit % for time-based exit (default: 15)
  dex_time_based_hold_hours?: number; // [TUNE] Hours before time-based profit taking (default: 2)

  // Momentum break - exit profitable positions when momentum dies (let runners run philosophy)
  dex_momentum_break_enabled?: boolean; // [TOGGLE] Exit winners when momentum dies (default: true)
  dex_momentum_break_threshold_pct?: number; // [TUNE] Momentum drop % to trigger exit (default: 50)
  dex_momentum_break_min_profit_pct?: number; // [TUNE] Min profit to take on momentum break (default: 10)

  // Cooldown behavior on API errors
  dex_cooldown_fail_closed?: boolean; // [TOGGLE] Block re-entry on API errors (default: true)

  // Lower trailing activation thresholds for high-risk tiers
  dex_breakout_trailing_activation?: number; // [TUNE] Trailing activation for breakout tier (default: 25)
  dex_microspray_trailing_activation?: number; // [TUNE] Trailing activation for microspray tier (default: 20)

  // Trailing stop loss - lock in gains by trailing the peak price
  dex_trailing_stop_enabled: boolean; // [TOGGLE] Enable trailing stop loss for DEX positions
  dex_trailing_stop_activation_pct: number; // [TUNE] % gain required before trailing stop activates
  dex_trailing_stop_distance_pct: number; // [TUNE] Distance from peak price for trailing stop
  dex_breakeven_buffer_pct?: number; // [TUNE] Buffer above entry for breakeven stop (default: 2%)

  // Scaling trailing stop - earlier activation, scales protection with gains
  dex_scaling_trailing_enabled?: boolean;       // [TOGGLE] Enable scaling trailing stop
  dex_scaling_trailing_activation_pct?: number; // [TUNE] Activation threshold (default: 10%)
  dex_scaling_max_drawdown_pct?: number;        // [TUNE] Max drawdown from peak (default: 45%)

  // Chart pattern analysis - use Birdeye OHLCV data to avoid buying tops
  dex_chart_analysis_enabled: boolean; // [TOGGLE] Enable chart pattern analysis before entry
  dex_chart_min_entry_score: number; // [TUNE] Minimum entry score (0-100) to enter position

  // Chart-based exit enhancements
  dex_exit_on_distribution?: boolean; // [TOGGLE] Exit winners when distribution detected (default: true)
  dex_distribution_min_profit_pct?: number; // [TUNE] Min profit % to trigger distribution exit (default: 15)
  dex_exit_at_resistance?: boolean; // [TOGGLE] Exit at resistance with weak volume (default: true)
  dex_resistance_buffer_pct?: number; // [TUNE] How close to resistance to trigger exit (default: 3)

  // Dynamic trailing stop - adjust distance based on chart analysis
  dex_dynamic_trailing_enabled?: boolean; // [TOGGLE] Enable dynamic trailing stop adjustments (default: true)
  dex_trailing_uptrend_multiplier?: number; // [TUNE] Multiply trailing distance in uptrend (default: 1.2)
  dex_trailing_downtrend_multiplier?: number; // [TUNE] Multiply trailing distance in downtrend (default: 0.5)

  // Stale winner protection - exit profitable positions when momentum dies
  dex_stale_winner_profit_pct?: number; // [TUNE] Min profit % to trigger stale winner exit (default: 10)
  dex_stale_winner_scans?: number; // [TUNE] Missed scans before stale winner exit (default: 3)
  dex_peak_profit_floor_pct?: number; // [TUNE] Protect this % of peak gains for big winners (default: 50)

  // Crisis Mode - Black Swan Protection System
  crisis_mode_enabled: boolean; // [TOGGLE] Enable crisis detection and auto-protection
  crisis_vix_elevated: number; // [TUNE] VIX level for elevated risk (default: 25)
  crisis_vix_high: number; // [TUNE] VIX level for high alert (default: 35)
  crisis_vix_critical: number; // [TUNE] VIX level for full crisis (default: 45)
  crisis_hy_spread_warning: number; // [TUNE] High yield spread bps for warning (default: 400)
  crisis_hy_spread_critical: number; // [TUNE] High yield spread bps for crisis (default: 600)
  crisis_btc_weekly_drop_pct: number; // [TUNE] BTC weekly drop % for risk signal (default: -20) - % change is the real signal, not absolute price
  crisis_stocks_above_200ma_warning: number; // [TUNE] % stocks above 200MA for warning (default: 30)
  crisis_stocks_above_200ma_critical: number; // [TUNE] % stocks above 200MA for crisis (default: 20)
  crisis_stablecoin_depeg_threshold: number; // [TUNE] USDT price below this = crisis (default: 0.985)
  crisis_gold_silver_ratio_low: number; // [TUNE] G/S ratio below this = monetary crisis signal
  crisis_check_interval_ms: number; // [TUNE] How often to check crisis indicators (default: 300000 = 5min)
  crisis_level1_position_reduction: number; // [TUNE] Reduce position sizes by this % at level 1 (default: 50)
  crisis_level1_stop_loss_pct: number; // [TUNE] Tighter stop loss at level 1 (default: 5)
  crisis_level2_min_profit_to_hold: number; // [TUNE] Min % profit to keep position at level 2 (default: 2)

  // New expanded crisis indicators
  crisis_yield_curve_inversion_warning: number; // [TUNE] Yield curve spread below this = warning (default: 0.25)
  crisis_yield_curve_inversion_critical: number; // [TUNE] Yield curve deeply inverted = critical (default: -0.5)
  crisis_ted_spread_warning: number; // [TUNE] TED spread above this = banking stress warning (default: 0.5)
  crisis_ted_spread_critical: number; // [TUNE] TED spread above this = banking crisis (default: 1.0)
  crisis_dxy_elevated: number; // [TUNE] DXY above this = elevated dollar strength (default: 105)
  crisis_dxy_critical: number; // [TUNE] DXY above this = flight to safety (default: 110)
  crisis_usdjpy_warning: number; // [TUNE] USD/JPY below this = yen carry unwind warning (default: 140)
  crisis_usdjpy_critical: number; // [TUNE] USD/JPY below this = yen carry unwind crisis (default: 130)
  crisis_kre_weekly_warning: number; // [TUNE] KRE weekly drop % for warning (default: -10)
  crisis_kre_weekly_critical: number; // [TUNE] KRE weekly drop % for crisis (default: -20)
  crisis_silver_weekly_warning: number; // [TUNE] Silver weekly rise % for warning (default: 10)
  crisis_silver_weekly_critical: number; // [TUNE] Silver weekly rise % for monetary crisis (default: 20)
  crisis_fed_balance_change_warning: number; // [TUNE] Fed balance sheet weekly % change for warning (default: 2)
  crisis_fed_balance_change_critical: number; // [TUNE] Fed balance sheet weekly % change for crisis (default: 5)
}

// ============================================================================
// SIGNAL AND POSITION TYPES
// ============================================================================

// [CUSTOMIZABLE] Add fields here when you add new data sources
export interface Signal {
  symbol: string;
  source: string; // e.g., "stocktwits", "reddit", "crypto", "your_source"
  source_detail: string; // e.g., "reddit_wallstreetbets"
  sentiment: number; // Weighted sentiment (-1 to 1)
  raw_sentiment: number; // Raw sentiment before weighting
  volume: number; // Number of mentions/messages
  freshness: number; // Time decay factor (0-1)
  source_weight: number; // How much to trust this source
  reason: string; // Human-readable reason
  timestamp: number; // Unix timestamp (ms) when signal was gathered
  upvotes?: number;
  comments?: number;
  quality_score?: number;
  subreddits?: string[];
  best_flair?: string | null;
  bullish?: number;
  bearish?: number;
  isCrypto?: boolean;
  momentum?: number;
  price?: number;
}

export interface PositionEntry {
  symbol: string;
  entry_time: number;
  entry_price: number;
  entry_sentiment: number;
  entry_social_volume: number;
  entry_sources: string[];
  entry_reason: string;
  peak_price: number;
  peak_sentiment: number;
}

export interface SocialHistoryEntry {
  timestamp: number;
  volume: number;
  sentiment: number;
}

export interface MomentumPosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: number;
  plannedStop: number;
  targetPrice: number;
  setupAtEntry: string;
  orderId?: string;
  // News-scalp positions exit unconditionally at this timestamp
  scalpUntil?: number;
  entrySnapshot: {
    score: number;
    rvol: number;
    changePct: number;
    distFromVwapPct: number;
    blueSky: boolean | null;
    note: string;
  };
}

export interface MomentumTradeRecord extends MomentumPosition {
  exitPrice: number;
  exitTime: number;
  exitReason: string;
  pnlUsd: number;
  pnlPct: number;
}

export interface SocialSnapshotCacheEntry {
  volume: number;
  sentiment: number;
  sources: string[];
}

export interface LogEntry {
  timestamp: string;
  agent: string;
  action: string;
  [key: string]: unknown;
}

export interface CostTracker {
  total_usd: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface ResearchResult {
  symbol: string;
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags: string[];
  catalysts: string[];
  timestamp: number;
}

export interface TwitterConfirmation {
  symbol: string;
  tweet_count: number;
  sentiment: number;
  confirms_existing: boolean;
  highlights: Array<{ author: string; text: string; likes: number }>;
  timestamp: number;
}

export interface PremarketPlan {
  timestamp: number;
  recommendations: Array<{
    action: "BUY" | "SELL" | "HOLD";
    symbol: string;
    confidence: number;
    reasoning: string;
    suggested_size_pct?: number;
  }>;
  market_summary: string;
  high_conviction: string[];
  researched_buys: ResearchResult[];
}

// ============================================================================
// DEX TRADING TYPES
// ============================================================================

export interface DexPosition {
  chain?: string; // "solana" default; "robinhood" etc. — per-chain expectancy comparison
  pairAddress?: string; // pool address for candle fetches (structure exits)
  lastChartReadAt?: number; // throttle: structural reads at ~60s cadence
  tokenAddress: string;
  symbol: string;
  entryPrice: number;
  entrySol: number;
  entryTime: number;
  tokenAmount: number;
  peakPrice: number;
  entryMomentumScore: number; // Track entry momentum for decay detection (#12)
  entryLiquidity: number; // Track entry liquidity for exit safety (#13)
  tier?: "microspray" | "breakout" | "lottery" | "early" | "established"; // Track for tier-specific rules
  missedScans?: number; // Track consecutive scans where token wasn't in signals (grace period for lost_momentum)
  lastKnownPrice?: number; // Last price seen when signal was available (for when signal is missing)
  // Entry-moment signal snapshot — lets post-hoc analysis test whether entries
  // arrive too late in the move (chasing tops) without any external data.
  entryPriceChange5m?: number;
  entryPriceChange1h?: number;
  entryBuyRatio1h?: number;
  entryAgeHours?: number;
}

export interface DexPortfolioSnapshot {
  timestamp: number;
  totalValueSol: number; // Total value in SOL (balance + positions)
  paperBalanceSol: number;
  positionValueSol: number;
  realizedPnLSol: number;
}

export interface DexTradeRecord {
  chain?: string;
  symbol: string;
  tokenAddress: string;
  entryPrice: number;
  exitPrice: number;
  entrySol: number;
  entryTime: number;
  exitTime: number;
  pnlPct: number;
  pnlSol: number;
  exitReason:
    | "take_profit"
    | "stop_loss"
    | "lost_momentum"
    | "manual"
    | "trailing_stop"
    | "breakeven_stop"
    | "scaling_trailing"
    | "distribution_exit"
    | "resistance_exit"
    | "liquidity_exit"
    | "stagnation"
    | "structure_exit"
    | "structure_top";
  tier?: "microspray" | "breakout" | "lottery" | "early" | "established";
  // Entry-moment snapshot (copied from the position at exit)
  entryMomentumScore?: number;
  entryPriceChange5m?: number;
  entryPriceChange1h?: number;
  entryBuyRatio1h?: number;
  entryAgeHours?: number;
}

export interface DexTradingMetrics {
  // Win rate and expectancy (#15)
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancy: number;
  profitFactor: number;
  // Sharpe ratio (#16)
  sharpeRatio: number;
  // Streak tracking (#17)
  maxConsecutiveLosses: number;
  currentLossStreak: number;
  maxDrawdownPct: number;
  maxDrawdownDuration: number;
  currentDrawdownPct: number;
}

// ============================================================================
// AGENT STATE
// ============================================================================

export interface AgentState {
  config: AgentConfig;
  signalCache: Signal[];
  positionEntries: Record<string, PositionEntry>;
  socialHistory: Record<string, SocialHistoryEntry[]>;
  logs: LogEntry[];
  costTracker: CostTracker;
  lastDataGatherRun: number;
  lastAnalystRun: number;
  lastResearchRun: number;
  lastPositionResearchRun: number;
  // Market-timing state driven by the Alpaca clock (null = never observed).
  lastPremarketPlanDayEt: string | null;
  lastClockIsOpen: boolean | null;
  lastKnownNextOpenMs: number | null;
  // Momo scanner watchlist (TradingView screener; ranked by score)
  momoWatchlist: import("../../providers/tradingview").MomoCandidate[];
  momoWatchlistUpdatedAt: number;
  lastMomoScanRun: number;
  // Chart-structure reads for watchlist symbols (and later, open positions)
  momoCharts: Record<string, import("./chart-structure").ChartRead>;
  // Momentum lane: open positions, closed-trade journal, daily loss tracking
  momentumPositions: Record<string, MomentumPosition>;
  momentumTrades: MomentumTradeRecord[];
  momentumDay: { day: string; realizedUsd: number } | null;
  // Premarket catalyst grades (LLM over real headlines), keyed by symbol
  momoCatalysts?: Record<
    string,
    { day: string; grade: "A" | "B" | "C" | "D"; catalyst: string; dilutionRisk: boolean; reasoning: string }
  >;
  // Daily-context cache (blue sky / overhead) — one bars fetch per symbol per day
  momoDailyContext?: Record<string, { day: string; blueSky: boolean | null; overheadPct: number | null }>;
  socialSnapshotCache: Record<string, SocialSnapshotCacheEntry>;
  socialSnapshotCacheUpdatedAt: number;
  signalResearch: Record<string, ResearchResult>;
  positionResearch: Record<string, unknown>;
  stalenessAnalysis: Record<string, unknown>;
  twitterConfirmations: Record<string, TwitterConfirmation>;
  twitterDailyReads: number;
  twitterDailyReadReset: number;
  premarketPlan: PremarketPlan | null;
  enabled: boolean;
  lastAlpacaErrorLog?: number; // Throttle for alpaca_unavailable log spam

  // DEX momentum trading state
  dexSignals: DexMomentumSignal[];
  dexPositions: Record<string, DexPosition>;
  dexTradeHistory: DexTradeRecord[];
  dexRealizedPnL: number;
  dexPaperBalance: number; // Virtual SOL balance for paper trading
  dexPortfolioHistory: DexPortfolioSnapshot[]; // Track value over time for charts
  lastDexScanRun: number;
  // DEX streak and drawdown tracking (#15, #16, #17)
  dexMaxConsecutiveLosses: number;
  dexCurrentLossStreak: number;
  dexMaxDrawdownPct: number;
  dexMaxDrawdownDuration: number; // Duration in ms
  dexDrawdownStartTime: number | null; // When current drawdown started
  dexPeakBalance: number; // Peak balance for drawdown calculation
  // Circuit breaker state (#10)
  dexRecentStopLosses: Array<{ timestamp: number; symbol: string }>;
  dexCircuitBreakerUntil: number | null;
  // Drawdown protection state (#11)
  dexPeakValue: number; // High water mark for drawdown calculation (total portfolio value)
  dexDrawdownPaused: boolean;
  // Stop loss cooldown tracking (#8) - price-based re-entry with consecutive loss tracking
  dexStopLossCooldowns: Record<
    string,
    {
      exitPrice: number;
      exitTime: number;
      fallbackExpiry: number;
      consecutiveLosses: number;
      totalLosses: number;
      // Severe (stop_loss) exits must recover to the pre-dump entry price,
      // not just bounce off the stop-out price. Optional for legacy records.
      entryPrice?: number;
      exitReason?: string;
      // Set instead of deleting the record when a re-entry is allowed, so
      // consecutive/total loss counters survive across re-entries. A cleared
      // record does not block entries; the next losing exit increments on top.
      clearedAt?: number;
      // True when the exit that created this record was a loss. Losing records
      // permit NO early clears (price-recovery or momentum) — full expiry only.
      losingExit?: boolean;
      // Set once the exited token was observed 50%+ above our exit within 2h
      // (missed-runner instrumentation for the trailing-stop question).
      missedRunnerLogged?: boolean;
    }
  >;
  // First time each token appeared as a buy candidate. Entries require the
  // token to have persisted across scans (rug guard: SPIDERCAT passed the
  // liquidity floor and went -98.7% eleven seconds after entry).
  dexCandidateFirstSeen?: Record<string, number>;
  // Chart-structure reads for DEX tokens (entry gate + structural exits)
  dexCharts?: Record<string, import("./chart-structure").ChartRead>;
  // Per-chain discovery funnel from the last scan (sourced vs qualified) —
  // makes a dry chain visible in the dashboard instead of only in logs.
  dexChainScanStats?: { chains: Record<string, { sourced: number; qualified: number }>; updatedAt: number };
  // Counterfactual tracking for the overextension cap: price at first block,
  // so later scans can answer "did we reject a winner (blocked_runner) or
  // dodge a dump (blocked_dump)?" with tape. Pruned after 24h.
  dexBlockedCandidates?: Record<
    string,
    {
      symbol: string;
      blockPrice: number;
      priceChange1h: number;
      blockedAt: number;
      outcomeLogged?: boolean;
    }
  >;
  // Crisis Mode state
  crisisState: CrisisState;
  lastCrisisCheck: number;
}

// ============================================================================
// SOL PRICE CACHE
// ============================================================================

export interface SolPriceCache {
  price: number;
  timestamp: number;
}

// ============================================================================
// SOURCE CONFIG - How much to trust each data source
// ============================================================================

export const SOURCE_CONFIG = {
  // [TUNE] Weight each source by reliability (0-1). Higher = more trusted.
  weights: {
    stocktwits: 0.85, // Decent signal, some noise
    reddit_wallstreetbets: 0.6, // High volume, lots of memes - lower trust
    reddit_stocks: 0.9, // Higher quality discussions
    reddit_investing: 0.8, // Long-term focused
    reddit_options: 0.85, // Options-specific alpha
    twitter_fintwit: 0.95, // FinTwit has real traders
    twitter_news: 0.9, // Breaking news accounts
  },
  // [TUNE] Reddit flair multipliers - boost/penalize based on post type
  flairMultipliers: {
    DD: 1.5, // Due Diligence - high value
    "Technical Analysis": 1.3,
    Fundamentals: 1.3,
    News: 1.2,
    Discussion: 1.0,
    Chart: 1.1,
    "Daily Discussion": 0.7, // Low signal
    "Weekend Discussion": 0.6,
    YOLO: 0.6, // Entertainment, not alpha
    Gain: 0.5, // Loss porn - inverse signal?
    Loss: 0.5,
    Meme: 0.4,
    Shitpost: 0.3,
  } as Record<string, number>,
  // [TUNE] Engagement multipliers - more engagement = more trusted
  engagement: {
    upvotes: {
      1000: 1.5,
      500: 1.3,
      200: 1.2,
      100: 1.1,
      50: 1.0,
      0: 0.8,
    } as Record<number, number>,
    comments: {
      200: 1.4,
      100: 1.25,
      50: 1.15,
      20: 1.05,
      0: 0.9,
    } as Record<number, number>,
  },
  // [TUNE] How fast old posts lose weight (minutes). Lower = faster decay.
  decayHalfLifeMinutes: 120,
};
