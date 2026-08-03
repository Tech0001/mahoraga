# MAHORAGA overnight tuning journal — 2026-08-02/03

Rules: paper-only; config knobs + clear bug fixes only; one change at a time; every change = evidence, before/after, timestamp.

## Baseline (04:57 first cycle)
- dex_lottery: enabled, 1-6h age, $15k min liq, 0.02 SOL/position, max 5, SL 35%, trailing activation +100%
- scaling trailing + breakeven enabled; microspray/breakout OFF
- starting paper balance 1.0 SOL

## Changes
1. **05:15 — Alpaca made non-fatal in the alarm loop** (mahoraga-harness.ts): fallback closed-market clock, isolated stock-lane phases, throttled error log. Evidence: alarm loop died at getClock() before the DEX block every cycle; persist() never ran (positions lost on 04:58 reload, WOBBLE double-buy). BUG FIX.
2. **05:23 — Jupiter real-time pricing un-gated** (dex-trading.ts): batch price fetch no longer requires JUPITER_API_KEY. Evidence: price v3 verified working unauthenticated (curl 200, 05:00); key-gate left the top-priority exit price feed dead all night. BUG FIX.
3. **05:23 — DexScreener direct-pair fallback before cached price** (dex-trading.ts): when Jupiter + signal both miss (token off trending = usually mid-dump), do a direct token-pair lookup; only then fall back to lastKnownPrice. Evidence: multiple exits logged priceSource=cached at stale (optimistic) prices — inflates paper results exactly on dump exits. MEASUREMENT FIX.

## Observations
- 05:00-05:20: 5 entries, 5 quick exits (scaling_trailing/lost_momentum), all ~flat-to-small-red; ~2%+ cost per round trip
- several exits used priceSource=cached — check cache age on exit path
- 05:42 "One" stop_loss exit at -41% vs 35% configured stop, priceSource=jupiter (un-gated feed WORKING). Gap-through of ~6pts in <11min hold: real-time pricing catches the dump but the 10-15s cycle still gaps past the stop. Datum for live-execution expectations (real fills worse than paper).

4. **06:20 — STRATEGY: severe-exit re-entry now requires full recovery to pre-dump entry price** (dex-trading.ts + types.ts). Evidence: 06:13 re-bought "One" 31min after its -41% stop-out — +49% above the stop price passed the +15% "recovery" rule, and the Birdeye dead-cat gate FAILS OPEN with no key (dex-trading.ts:780 "No Birdeye = allow re-entry"), and Birdeye has no candle quality in the 1-6h window anyway (Director). New rule: stop_loss exits re-enter only at >= original entry price (true round-trip recovery); mild exits keep exit+15% (validated by the 05:48 DOGE re-entry, +5% win). No new data source. Cooldown records now carry entryPrice + exitReason.

5. **06:25 hourly pass #2 — stats + INSTRUMENTATION.** Stats @9 trades: bleed -0.026 SOL (6 losers) vs tail +0.095 SOL (3 winners) = 3.6:1, realized +0.069 SOL. lost_momentum avg -5.2%, scaling_trailing avg +4.6%, one -41.8% stop. NO entry-rule change — n too small and expectancy positive. Added entry-moment snapshot (priceChange5m/1h, buyRatio1h, ageHours) to DexPosition + DexTradeRecord so the entered-too-late hypothesis is testable on data from here on.
- 06:28 VALIDATION of change #4: the 06:13 "One" dead-cat re-entry (bought pre-fix) exited -18.8% lost_momentum. Exactly the trade the new entry-price-recovery rule blocks. "One" now also at 2 consecutive losses = blocked by that guard too.

6. **07:05 — STRATEGY BUG FIX: loss counters now survive re-entries** (dex-trading.ts + types.ts). Evidence: 07:00 "One" re-bought at $0.000157 (BELOW its last losing exit $0.000203) via cooldown_cleared_high_momentum (72.6>=70) — the consecutive-loss guard never fired because every allowed re-entry DELETED the cooldown record and erased the counters ("One": 3 losses tonight, counter never exceeded 1). Fix: clearing marks clearedAt instead of deleting; counters accumulate across re-entries; next losing exit increments on top. Known tradeoff journaled: profitable exits do NOT reset the consecutive counter (original design) — with surviving counters this is now more restrictive; revisit with data. "One" cost tonight: -41.8%, -18.8%, -8.4%.

7. **07:18 — momentum-clear now requires price >= last losing exit price** (dex-trading.ts). Evidence: the high-momentum branch bypassed both price gates; "One" re-entered 23% BELOW its losing exit on momentum 72.6 and lost -7.7% (n=1 closed, plus structural argument). DECK 07:15 re-entered ABOVE its last exit via the same branch — stays legal (live test case, open). Rule blocks only below-exit momentum re-entries.
- 07:10 checked sub-2min churn against tape: min-hold NOT adopted — fast momentum exits saved money on knives (82s/-7.7% would have been worse held); median hold 4.6min, winners ran 14-69min. No change.
- 07:20 PENDING EVIDENCE: re-entries after LOSING exits now 0/3 tonight (-18.8% recovery-clear, -7.7% momentum-clear below exit, -14% momentum-clear above exit); re-entries after WINNING exits = the profit engine (+28%, ~flat, 1 open). Candidate change #8 (next pass, if pattern holds): losing-exit records allow NO early clears — full 2h expiry only. Current stack already blocks 2-strike tokens (DECK now blocked, counters surviving as designed).

8. **07:45 hourly pass #3 — LOSER LOCKOUT adopted** (types.ts + dex-trading.ts). Losing-exit cooldowns permit no early clears (recovery or momentum): full 2h expiry + counters only. Evidence: loser re-entries 0/3 (-18.8, -7.7, -14.2), winner re-entries = the profit engine (+28, +1.6, wiwiwi open); pre-committed 07:20, no counter-evidence since. Winner-exit path unchanged (30-min expiry). Stats @16: 4W/12L, realized +0.0235 SOL, hour 2 net negative. Entry-snapshot early reads (n=4, NO action yet): Shipy entered +413%/1h -> flat (overextension signature); DECK entered buyRatio 0.39 -> -14% (sell-pressure signature). Revisit entry filters at n>=15 snapshots.

9. **07:55 — TWO fixes from one event.** (a) BUG: loss-counter guards moved BEFORE the price-recovery clear — DECK re-entered at 07:47 through its legacy record because recovery-clear ran first and never consulted its 2 strikes. (b) STRATEGY: candidate persistence rug guard — a token must appear as a candidate on 2+ scans (>=45s) before it is buyable. Evidence: SPIDERCAT passed the $15k liquidity floor and stop-lossed -98.7% ELEVEN SECONDS after entry (liquidity spoofed then pulled). Cost: entries delayed one scan (~60s); real runners persist scans all night (DOGE/wiwiwi). First-seen map prunes at 24h.

10. **08:15 hourly pass #4 — OVEREXTENSION CAP at entry** (dex_max_entry_1h_change=150, all DEX entries). Evidence (snapshot n=7): loss median entry 1h = +160%, win median = +13%; the three worst trades entered at +10413%/+413%/+247% 1h; momentum score ANTI-predictive (loss med 82 vs win med 63); the only snapshot winner entered on a 5m dip. Cap blocks -98.9/-37.0/-1.1 from the sample, touches no sampled winner. CAVEAT journaled: pre-instrumentation winners (wiwiwi +29, DOGE +28) have unknown entry extension — cap set generous (150 not 100) for that reason. HONEST LEDGER @19 trades: realized -0.0859 SOL, 4W/15L, wiwiwi open.

11. **09:30 hourly pass #5 — drawdown pause deadlock + EVALUATION-MODE limit raise.** Found trading silently paused ~1h (drawdown_pause_active every cycle): pause lifts ONLY on a new equity high, but the pause blocks the entries that could produce one (near-deadlock with 1 open position). Code fix: also unpause when drawdown < configured limit. Config: dex_max_drawdown_pct 35 -> 60 FOR THIS PAPER EVALUATION ONLY — new entry gates (rug guard, overextension cap) had zero data because of the pause. ⚠️ RESTORE 35 (or tighter) BEFORE ANY LIVE DEPLOYMENT — in live the pause is sacred.

12. **09:45 — unicode-abuse entry filter** (dex-trading.ts). Evidence: "dͨoͣgͭ" (combining diacritics) persisted 2+ scans past the rug guard then pulled -66% in 13s. Combining marks / zero-width chars in symbol/name = impersonation signature, ~zero false-positive cost (legit tokens use plain text or emoji). Rug-class losses now 2/21 trades (-98.9, -66) = the dominant bleed source; entry filtering is the only defense the stop cannot provide.

13. **10:20 — BUG: 24h total-loss guard was unreachable after 2h** (dex-trading.ts). The consecutive-loss branch clears at fallbackExpiry (2h) BEFORE the total-loss check runs, so "3 losses in 24h = blocked" could never fire past 2h. Evidence: DECK re-entered at 10:14 with totalLosses=3 (0-for-4 tonight, -38% cumulative) straight through the expired consecutive branch. Total-loss guard moved to the top of the chain — serial losers now sit out the full 24h as documented.

14. **10:45 hourly pass #6 — CONFIGURATION FREEZE until morning.** Post-full-stack cohort too small and mid-freeze exits ugly (LetsPlay recovery re-entry -31%, DECK 5th loss -3% now 24h-blocked, CHUBBYDOG -2%). Rationale: gate-per-loss at n~25 = curve-fitting; 3-5am UTC Sunday = deadest liquidity of the week (worst evaluation window). Bug fixes still allowed; no new strategy knobs. Frozen stack: 2-scan persistence, +150%/1h overextension cap, unicode-abuse filter, loser lockout 2h, 24h total-loss guard (ordering fixed), surviving counters, price-floored momentum clears, drawdown 60 EVAL-ONLY. Morning deliverable: frozen-config expectancy, full table, and the go/no-go read for the week plan.

15. **11:30 — BUG-CLASS EXCEPTION TO FREEZE: rug-class exits (>=90% loss) count as 3 strikes -> 24h ban via existing total-loss guard.** Evidence: SPIDERCAT rugged -99% TWICE (07:47 and 11:25, identical 11-19s signature) — cyclical honeypot; the 4x "recovery" that legally cleared the entry-price rule was the re-bait. Narrow fix reusing the existing guard; no legitimate token loses 90% and merits same-day re-entry.

16. **13:00 — DEAD-HOURS PAUSE (operational, book flat).** wiwiwi closed +23% (+0.058 SOL, 6.3h hold, biggest position). ODONGI = honeypot #4 (-99.7% in 11s). Dead-hours measurement complete: 4 rugs / ~10 post-stack entries in the 10:00-13:00 UTC window — honeypot donation rate dwarfs winner capture with no open-chain security data. Book flat -> dex_enabled=false until ~14:30 UTC (US pre-market); resume for the liquid-hours measurement. Ledger at pause: 30 trades, 7W/23L, realized -0.1826 SOL, balance 0.5174 (equity = balance, flat book).

---

# MORNING REPORT — overnight paper session 04:57-13:00 UTC

**Ledger:** 1.000 -> 0.5174 SOL (flat book). 30 trades, 7W/23L. Realized -0.1826 SOL; the rest of the gap is gas (60 tx x 0.005 SOL).

## Full trade table

| # | symbol | held | exit | pnl% | pnlSOL |
|---|--------|------|------|------|--------|
| 1 | trenchcat | 91s | lost_momentum | -2.1 | -0.0004 |
| 2 | WOBBLE | 4m | scaling_trailing | -4.3 | -0.0009 |
| 3 | DogeFart | 3m | scaling_trailing | -3.1 | -0.0006 |
| 4 | DOGE | 5m | lost_momentum | -6.8 | -0.0014 |
| 5 | DECK | 17m | scaling_trailing | -3.3 | -0.0035 |
| 6 | One | 11m | stop_loss | -41.8 | -0.0084 |
| 7 | DOGE | 4m | lost_momentum | 4.9 | 0.001 |
| 8 | wiwiwi | 69m | scaling_trailing | 29.2 | 0.0939 |
| 9 | DECK | 27m | lost_momentum | -16.9 | -0.0109 |
| 10 | One | 16m | lost_momentum | -18.9 | -0.0038 |
| 11 | DOGE | 14m | scaling_trailing | 27.3 | 0.0055 |
| 12 | One | 82s | lost_momentum | -7.7 | -0.0015 |
| 13 | DOGE | 32s | lost_momentum | 1.6 | 0.0003 |
| 14 | BRICK | 79m | lost_momentum | -15.7 | -0.0305 |
| 15 | DECK | 87s | lost_momentum | -14.2 | -0.0151 |
| 16 | Shipy | 25m | scaling_trailing | -1.1 | -0.0002 |
| 17 | SPIDERCAT | 10s | stop_loss | -98.9 | -0.0991 |
| 18 | LetsPlay | 8m | stop_loss | -37.0 | -0.0074 |
| 19 | DECK | 26m | scaling_trailing | -3.6 | -0.0029 |
| 20 | NamNoi | 10m | lost_momentum | 4.7 | 0.0009 |
| 21 | dͨoͣgͭ | 12s | stop_loss | -66.4 | -0.0503 |
| 22 | CHUBBYDOG | 119s | lost_momentum | 9.3 | 0.0019 |
| 23 | DECK | 14m | scaling_trailing | -2.1 | -0.0013 |
| 24 | LetsPlay | 34m | lost_momentum | -30.7 | -0.0061 |
| 25 | CHUBBYDOG | 47s | lost_momentum | -2.0 | -0.0004 |
| 26 | SPIDERCAT | 19s | stop_loss | -99.7 | -0.058 |
| 27 | DOGE | 8m | scaling_trailing | -3.6 | -0.0017 |
| 28 | PEEK | 21s | stop_loss | -99.4 | -0.0199 |
| 29 | ODONGI | 10s | stop_loss | -99.8 | -0.02 |
| 30 | wiwiwi | 381m | scaling_trailing | 23.1 | 0.0581 |

**Economics:** winners +0.1616 SOL (7), ordinary losers -0.0969 SOL (18), RUGS -0.2473 SOL (5: SPIDERCAT -99%, dͨoͣgͭ -66%, SPIDERCAT -100%, PEEK -99%, ODONGI -100%).

**The one number that matters:** remove the honeypots and the night is near break-even; with them it is -18%% before gas. Rug filtering via on-chain security data (LP lock, mint authority, holder concentration — RugCheck/Helius class) is the highest-leverage build item, ahead of any further knob tuning. Gas (0.005/tx) also ate ~0.30 SOL across 60 tx — real-world priority fees are lower; recalibrate the paper gas model.

17. **13:45 — GAS MODEL CORRECTED 0.005 -> 0.001 SOL/tx** (config default + live). Gas was the largest single cost overnight (0.30 of 0.48 SOL, 60 tx); real Jupiter swaps run 0.0005-0.0015 SOL incl. priority + amortized ATA rent. Ledger re-read at realistic gas: night ~= -0.12 SOL, near-flat despite 4 honeypots in the worst window. DEX RE-ENABLED for liquid-hours measurement.


18. **14:10 — HONEYPOT LAYER (Director-directed) + missed-runner instrumentation.**
- Gate 1, sell-activity floor: require >=15 real sells in 1h AND buyRatio <= 0.85. The "no withdrawals" check — a token nobody has sold is a token nobody CAN sell (SPIDERCAT entered at 0.91 buy ratio).
- Gate 2, exit-route viability: real Jupiter SELL quote for the position size before entry (paper-safe analog of the dust canary); no route or >25% impact = skip. Quote host migrated: quote-api.jup.ag/v6 (dead) -> lite-api.jup.ag/swap/v1, verified live.
- Missed-runner instrumentation: log when an exited token trades 50%+ above our exit within 2h — answers the February "trailing stop closes runners early" question with tape.
- Live dust canary (buy dust -> sell half -> confirm -> size up) specced for the live executor; not implementable in paper.

19a. **14:34 — OBSERVATION (no change): first post-stack runner captured.** SOUNDSBIG (established tier, 12d old, $110k liq) entered 14:15:52 — 5 min after the honeypot layer went live, passing every gate (1h change +87% < 150 cap, buyRatio 0.53, sell-route viable) — and exited 14:33:36 scaling_trailing at **+241.9% / +0.4082 SOL in 17.7 min** (0.1687 SOL established-lane sizing). Largest single trade of the run; realized PnL flipped -0.1867 -> +0.2215 SOL, PF 0.46 -> 1.64. Evidence FOR the current stack: the trailing machinery rode a 3.4x without amputating it. Watch missed_runner on SOUNDSBIG (fires if it trades >$0.009 within 2h of exit) — that would be the counter-signal. wiwiwi re-entry 14:28 (winner-cooldown regime) open at -4.5%.

19b. **14:47 hourly pass — stack behaving, no action.** Ledger: 0.8038 cash, realized +0.2215, 32 trades 8W/24L, PF 1.64, wiwiwi open ~flat. Post-stack entries: 2 admitted (SOUNDSBIG +242% closed, wiwiwi open), 2 tokens blocked for cause (DECK 24h total-loss ban ×66 scans; BBQCOIN overextended +484%/1h vs 150 cap ×48 scans) — gates neither silent nor over-tight. missed_runner: 0 (SOUNDSBIG counter-signal window open to ~16:33). Alarm heartbeat 8s fresh. 18 trades to the 50-trade verdict.

20. **15:30 — UPSTREAM PORTS (Director-approved) + instrumentation.** Hand-ported every functional fix from ygwyg/MAHORAGA (fork point Feb 4; their strategy-pattern refactor deliberately NOT taken — collides with our harness/ module split; revisit post-evaluation). Baseline commit b778347 preserves the overnight work separately.
- PR#26 core loop: position research had NEVER re-run (checked lastResearchRun, which signal research resets every 2min — 5min condition unreachable); now lastPositionResearchRun. Premarket plan/execute now driven by the Alpaca clock (next_open window + ET-day marking + cold-start rules + stale-plan clearing) instead of server-LOCAL-time heuristics (9:25am local on this box = ET-wrong by 2h). lastClockIsOpen only updates from a REAL clock observation (fallback clock is not evidence).
- PR#27 social: socialHistory was never populated (only deleted) and the live staleness call passed currentSocialVolume=0 HARDCODED (trading.ts:397) — every stock position read as fully volume-decayed. Now: volume-weighted per-symbol snapshot across sources, 5-min buckets, 24h pruning, snapshot-cache with cold-start fallback; entry records use aggregated volume.
- Config: premarket_plan_window_minutes=5 (1-60), market_open_execute_window_minutes=2 (0-10) + zod + SettingsModal + tests (57/57 pass). Dashboard LineChart width/hover fix.
- NEW blocked-candidate instrumentation: overextension blocks now snapshot first-block price; later scans log blocked_runner (>=+50% since block = we rejected a winner) or blocked_dump (<=-50% = cap saved us). 24h prune. Settles the "are we rejecting winners" question with tape.
- OPERATIONAL LESSON (cost real money): incremental saves on the tsc-watched tree crashed the dev server TWICE (~4min unmanaged); BBQCOIN entered seconds before crash #2 and stop-lossed -40% vs the 35% configured stop on restart. Rule going forward: same-file edits land as one rapid batch, tsc + health check immediately after, restart script on standby.
- 15:26 — BBQCOIN was stop-loss #8 in the 24h window -> CIRCUIT BREAKER: DEX entries paused until 16:26 UTC (exits unaffected). Window still carries the overnight rugs; expect re-trips on each new stop until those age out (~04:57 tomorrow).

21. **15:50 — STOCK LANE LIVE + LLM provider/model config (Director-directed).** Real Alpaca paper keys in (.dev.vars, acct PA3DIAHWL8TM), market clock live (fallback-clock CLOSED bug was stale env — wrangler does NOT hot-reload .dev.vars; full restart required). OpenRouter wired via openai-raw + OPENAI_BASE_URL (Director's key initially landed on the LLM_PROVIDER line — fixed). First LLM research cycle verified live: PGY -> SKIP conf 0.4, $0.008/5 calls tracked. Models set from LIVE OpenRouter prices (queried, not memory): research=deepseek/deepseek-v4-flash-0731 ($0.09/$0.18 per M), analyst=deepseek/deepseek-v4-pro ($0.435/$0.87) replacing gpt-4o-mini/gpt-4o — gpt-4o was frontier-priced ($2.50/$10) 2024-era intelligence, strictly dominated. Est. analyst cost ~$0.35/market-day vs ~$3. Frontier option if premarket/opening-drive later wants it: openai/gpt-5.1 ($1.25/$10). Runtime-swappable via POST /agent/config, no restart.

22. **15:55 — LLM response validation + dashboard hardening (commit 69a41fb).** First DeepSeek cycle surfaced a latent bug: signalResearch records were persisted UNVALIDATED — one malformed response stored all-null fields (FSLR) and crashed the entire dashboard on render (entry_quality.toUpperCase). Fix both ends: worker validates verdict/confidence (drop + invalid_llm_response log otherwise) and coerces quality/arrays; dashboard filters malformed records at render. Also: curated model quick-pick chips (with prices) under both model fields per Director request; settings provider relabeled OpenAI-compatible with live OpenRouter catalog datalist (commit 8aca594). NOTE: my earlier "18-min alarm stall" diagnosis was FALSE — a timeline arithmetic error on my part; the loop never stalled (verified: heartbeats continuous through the window). Session process accidentally stopped ~15:49 by Director; monitor re-armed, no trading impact (book flat, breaker paused).

23. **16:30 — MOMO SCANNER LANE (Director-directed: "alpaca it is, tradingview for data").** New informational lane, no trading decisions: TradingView screener provider (scanner.tradingview.com, unofficial/free — consolidated tape, rvol, float; Alpaca free IEX is 2-3% of tape, SIP fix costs $99/mo), momo gatherer on 60s interval during premarket (within 330min of next_open ≈ 4:00 ET) + market hours, ranked watchlist in state + /agent/status + dashboard panel. Scoring v0: changePct × log10(volume) × 1.25-if-near-high (Director's eye: "green, has action, holding highs") — calibration sessions tune this. Config: momo_* knobs (8), zod-validated, 57/57 tests. First live scan 16:27:27: UPC +136.7% score 998, EZRA 583.9x rvol, BOW flagged NEAR-HIGH — exactly the Director's old TradingView workflow, automated. Feeds tomorrow's 7:30 ET opening-drive calibration.
- OBSERVED: stock lane actively trading via DeepSeek analyst — 6 Alpaca paper positions (MLTX, PGY, RUM, SERV, SOFI, TGTX), equity +$183 on day one with real keys. lmeow (DEX lottery, 0.02 SOL) +79% unrealized at check.

24. **16:50 analysis pass — POST-STACK COHORT STRONGLY POSITIVE + first blocked_runner + LLM empty-content fix.**
- Post-stack cohort (entries after 14:10): 10 closed, 3W/7L, **net +0.4097 SOL**. Winners +241.9/+85.6/+19.6%; all losers scratches (-0.1 to -4.5%) except BBQCOIN -40.6 (edit-crash downtime, journaled entry 20). **Zero rugs in 10 post-stack entries** vs 5 rugs/30 overnight — the honeypot layer is the difference. Tail-to-bleed 22:1 (overnight: 3.6:1). Even ex-SOUNDSBIG the cohort is ~breakeven — the stack stopped the bleed. Ledger: 0.901 SOL, 41 trades, PF 1.61. 9 trades to the 50-trade verdict.
- **First blocked_runner: NEKO +96% since its +699%/1h block.** First counter-datum against the overextension cap (SOUNDSBIG re-entry block and BBQCOIN clone supported it). n=1 — keep collecting; no knob change.
- missed_runner still 0 — trailing exits are not amputating runners on today's tape.
- **BUG FIX: 15 invalid_llm_response, all content='{}'** — deepseek-v4-flash is reasoning-capable; reasoning tokens consumed the max_tokens=250 budget and returned EMPTY content. Fix: OpenRouter requests now send reasoning:{enabled:false} (structured-output calls; verified live: content populated, reasoning_tokens 0) + research max_tokens 250->600. The 15 wasted calls were caught by entry-22 validation — no bad records persisted.
- Stock lane: 6 positions, equity $99,974 (~flat). Momo watchlist live with 12 names.

25. **17:35 — MOMENTUM LANE: chart-structure engine + execution module (Director-directed vision: "pre-informed decisions from chart data, monitor active trades with the chart").**
- chart-structure.ts: one shared brain for entry/trigger/in-trade — session VWAP, opening range (next_close - 6.5h, clock-derived), HOD distance, swing pivots (higher-lows/lower-highs), flag tightness (5-bar range contraction), volume expansion, daily context (blue sky within 2% of 52w high / overhead supply to 60d high, cached 1 fetch/symbol/day). Setups: ORB/FLAG/VWAP_HOLD (actionable, with pre-planned trigger+stop) / EXTENDED / FADING / BREAKDOWN. First live reads correct: morning gappers HYFM/EZRA labeled BREAKDOWN at 1:15pm (the aftermath trap the screener alone would walk into). v0 bug fixed same session: ORB matched any price ABOVE the opening range (midday false positives, stop>trigger) — now requires price within [0.99, 1.02]x OR-high + plan-sanity guard (stop>=trigger -> plan withheld).
- momentum-trading.ts: SHIPS DISABLED (momentum_trading_enabled=false). Entries: actionable setup + fresh trigger break only (<=1.5% through), $500/position, max 3, no entries <30min to close. Exits every 10s cycle: structural (breakdown/descending wedge >=3 lower highs/VWAP lost/fading underwater) primary; hard stop, 2R target, 45min time exit, EOD flatten <=5min as rails. $150 daily loss cap halts the lane. Alpaca paper market orders; every trade journaled with entry-moment snapshot (setup, score, rvol, VWAP dist, blue sky) for per-lane expectancy — the DEX discipline applied to stocks.
- Arm criteria: Director calibrates setup labels against real charts (tomorrow's open), then flips the flag together.
- 17:50 addendum: catalyst grader live (commit 7871184) — premarket-only, LLM (analyst model) over REAL Alpaca news headlines, grades A/B/C/D + dilution-risk flag, once per symbol per day, validated before persist, CAT column in panel. Completes the premarket stack: scan -> chart read -> catalyst grade -> (disabled) execution.

19. **14:15 — SESSION HANDOFF: new agent on watch.** No config changes. State at takeover: 31 trades (7W/24L, balance 0.5113, realized -0.1867), one trade since morning report (DOGE lost_momentum -4.8%). Alarm loop healthy (10s heartbeat, DEX ON), discovery finding candidates, 24h total-loss guard actively blocking DECK (4 losses). Honeypot layer (entry 18) live 5 min — zero post-stack entries yet, zero missed_runner events yet. Monitoring cadence: 30-min first check (verify new gates aren't over-tight / entries still possible), then hourly passes. Expectancy verdict due at 50+ trades per handoff plan. Note: /agent/logs defaults to last 100 entries but honors ?limit= up to the DO's 500-entry retention (~75 min at current event rate) — hourly passes use limit=500 for full coverage; trade records + cooldowns persist and are the primary dataset. Monitoring now: 60s event poller (trades, missed_runner, gate blocks 1/hr-deduped, stall/unreachable detection) + hourly analysis passes.
