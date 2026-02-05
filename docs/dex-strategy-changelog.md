# DEX Trading Strategy Changelog

> **Note**: The DEX momentum trading system (Solana tokens via DexScreener/Birdeye) is an extension
> not covered in the original docs. The base MAHORAGA system handles stocks/crypto via Alpaca with
> LLM sentiment analysis. This changelog tracks improvements to the DEX extension.

---

## 2026-02-05: Architecture Refactor

### Monolith → Modules

The original `mahoraga-harness.ts` was 5638 lines. We extracted domain-specific modules using a `HarnessContext` dependency injection pattern.

**New structure:**
```
src/durable-objects/
├── mahoraga-harness.ts     (1224 lines - orchestration only)
└── harness/
    ├── context.ts          (48 lines - HarnessContext interface)
    ├── types.ts            (types and interfaces)
    ├── utils.ts            (shared utilities)
    ├── crisis.ts           (567 lines - crisis detection)
    ├── dex-trading.ts      (879 lines - DEX momentum trading)
    ├── gatherers.ts        (428 lines - data gathering)
    ├── llm-research.ts     (435 lines - LLM analysis)
    ├── notifications.ts    (124 lines - Telegram alerts)
    ├── options.ts          (249 lines - options trading)
    ├── routes.ts           (334 lines - HTTP endpoints)
    ├── staleness.ts        (105 lines - stale position detection)
    ├── trading.ts          (715 lines - stock/crypto execution)
    └── twitter.ts          (274 lines - Twitter confirmation)
```

**Why**: The monolith was hard to navigate and modify. Now each domain has its own file.

**Pattern used**: `HarnessContext` provides access to `state`, `env`, `llm`, `log()`, `persist()` so modules don't need direct class references.

> **Docs note**: The `harness.html` doc references line numbers in the old monolith. Those are now invalid - look in the extracted module files instead.

### New Features Added

**Telegram Trade Alerts** (`notifications.ts`)
- Sends alerts on trade entry/exit
- Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.dev.vars`
- Format: Entry/exit with symbol, price, P&L, reason

**Alarm Visibility Logging**
- `alarm_heartbeat` - Shows what phases will run each cycle
- `phase_start` - Marks beginning of each phase (data_gather, dex_trading, analyst)
- `alarm_complete` - Shows cycle duration

**Birdeye Rate Limiting Fix**
- Module-level timestamp (persists across instances)
- Retry with exponential backoff on 429 errors
- Increased delay from 1.5s to 2.5s between requests

---

## 2026-02-05: Win Rate Optimization

### Problem Analysis

**Baseline metrics (10 trades):**
- Win Rate: 20% (2 wins, 8 losses)
- Avg Win: +23.1%
- Avg Loss: -12.0%
- Expectancy: -5.0% per trade
- Profit Factor: 0.41
- Max Consecutive Losses: 7

**Critical issues identified:**

1. **Trailing stop bug** - Two trades (LinhMai -28%, Dream -29%) exited via `trailing_stop` with large LOSSES. This should be impossible since trailing stop should only activate after a position is UP significantly.

2. **Take profit cutting winners** - Fixed take_profit at 100% was immediately exiting, preventing potential 500%+ runners.

3. **Exit reasons analysis:**
   - `lost_momentum`: 5 trades, all small losses (-1% to -3%) - WORKING WELL
   - `trailing_stop`: 4 trades - 2 wins (+14%, +32%), 2 BUGGY losses (-28%, -29%)
   - `stop_loss`: 1 trade (-32%)

---

### Changes Implemented

#### 1. Trailing Stop Safety Check (CRITICAL FIX)
**File:** `src/durable-objects/harness/dex-trading.ts`

**Problem:** Trailing stop was triggering on positions that were never meaningfully profitable.

**Fix:** Added `peakWasMeaningful` check - peak price must be at least 5% above entry before trailing stop logic applies. If not, falls through to fixed stop loss.

```typescript
const peakWasMeaningful = position.peakPrice > position.entryPrice * 1.05;
if (peakGainPct >= activationPct && peakWasMeaningful) {
  // Legitimate trailing stop
}
```

#### 2. Let Winners Run (MAJOR IMPROVEMENT)
**File:** `src/durable-objects/harness/dex-trading.ts`

**Problem:** Immediate `take_profit` at 100% was cutting winners short. LinhMai hit +99% and exited, but memecoins can run to 2000%+.

**Fix:** Removed the immediate take_profit exit. Now when position hits the activation threshold (100%), trailing stop activates and TRACKS THE PEAK. Position only exits when price drops 20% from peak.

**Example:**
- Entry at $0.00001
- Hits +100% ($0.00002) → trailing stop activates, tracks peak
- Moons to +2000% ($0.00021) → peak price updated
- Drops to +1600% ($0.000168) → trailing stop triggers
- Result: +1600% profit instead of +100%

Added `runner_mode_active` log to track when positions are in runner mode.

#### 3. Tier-Specific Stop Losses
**File:** `src/durable-objects/harness/dex-trading.ts`

**Rationale:** Different tiers have different risk profiles.

- **Lottery/Microspray/Breakout:** 20% stop loss (was 30%)
- **Early:** 25% stop loss
- **Established:** 30% stop loss (unchanged)

#### 4. Higher Momentum Score Floor
**File:** `src/durable-objects/harness/dex-trading.ts`

**Change:** Minimum momentum score raised from 50 to 60.

**Rationale:** Quality over quantity. Only trade tokens with stronger momentum signals.

---

### Changes Considered But REJECTED

#### Overextended Filter (>400% 24h rejection)
**Rejected because:** For Solana memecoins, 400%+ gains ARE the momentum signal. That's what we're trying to capture.

#### Faster Lost Momentum Exit (10 → 6 scans)
**Rejected because:** Tokens can consolidate before making bigger moves. Cutting too fast locks in losses. Keep the 10-scan (~5 min) grace period.

#### Score Penalty for Extreme 24h Gains
**Rejected because:** Big gains ARE the momentum signal we want. Don't penalize the exact thing we're trying to buy.

---

### Key Philosophy

**Win SIZE > Win RATE**

For memecoins, a 25% win rate with +300% avg win and -20% avg loss is highly profitable:
- 100 trades: 25 wins × 300% = 7500% gains
- 100 trades: 75 losses × 20% = 1500% losses
- Net: +6000% / 100 trades = +60% avg per trade

Let the runners run. Don't cut winners. Take small losses on losers.

---

### Monitoring Checklist

Track these metrics over next 50+ trades:

- [ ] No more `trailing_stop` exits with negative P&L
- [ ] `runner_mode_active` logs appearing when positions moon
- [ ] Avg win size increasing (target: +100% to +500%)
- [ ] Win rate ~30-35% (slight improvement from quality filter)
- [ ] Expectancy turning positive (+5% to +20%)
- [ ] Profit factor > 1.5

### How to Check Current Stats

```bash
curl -s -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8787/agent/status | jq '.data.dexPaperTrading | {winRate, avgWinPct, avgLossPct, expectancy, profitFactor, totalTrades}'
```

---

### Files Modified

1. `src/durable-objects/harness/dex-trading.ts`
   - Trailing stop safety check
   - Removed immediate take_profit
   - Added runner_mode_active logging
   - Tier-specific stop losses
   - Momentum floor 50 → 60

2. `src/durable-objects/harness/types.ts`
   - Added `dex_lottery_stop_loss_pct` config option
   - Added `dex_early_stop_loss_pct` config option

3. `src/providers/birdeye.ts`
   - Fixed rate limiting (module-level timestamp)
   - Added retry with exponential backoff for 429 errors

4. `src/durable-objects/harness/notifications.ts` (NEW)
   - Telegram trade alerts for entries/exits

5. `src/durable-objects/mahoraga-harness.ts`
   - Added alarm heartbeat logging
   - Added phase logging for visibility
