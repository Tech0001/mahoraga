/**
 * MahoragaHarness - Autonomous Trading Agent Durable Object
 * 
 * A fully autonomous trading agent that runs 24/7 on Cloudflare Workers.
 * This is the "harness" - customize it to match your trading strategy.
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW TO CUSTOMIZE THIS AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 1. CONFIGURATION (AgentConfig & DEFAULT_CONFIG)
 *    - Tune risk parameters, position sizes, thresholds
 *    - Enable/disable features (options, crypto, staleness)
 *    - Set LLM models and token limits
 * 
 * 2. DATA SOURCES (runDataGatherers, gatherStockTwits, gatherReddit, etc.)
 *    - Add new data sources (news APIs, alternative data)
 *    - Modify scraping logic and sentiment analysis
 *    - Adjust source weights in SOURCE_CONFIG
 * 
 * 3. TRADING LOGIC (runAnalyst, executeBuy, executeSell)
 *    - Change entry/exit rules
 *    - Modify position sizing formulas
 *    - Add custom indicators
 * 
 * 4. LLM PROMPTS (researchSignal, runPreMarketAnalysis)
 *    - Customize how the AI analyzes signals
 *    - Change research criteria and output format
 * 
 * 5. NOTIFICATIONS (sendDiscordNotification)
 *    - Set DISCORD_WEBHOOK_URL secret to enable
 *    - Modify what triggers notifications
 * 
 * Deploy with: wrangler deploy -c wrangler.v2.toml
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";
import { createAlpacaProviders } from "../providers/alpaca";
import type { Account, LLMProvider } from "../providers/types";
import { createLLMProvider } from "../providers/llm/factory";
// TODO: Re-enable when Solana wallet is configured for execution
// import { createJupiterProvider } from "../providers/jupiter";

// Import types, config, and utilities from harness modules
import type {
  AgentConfig,
  Signal,
  LogEntry,
  DexPosition,
  AgentState,
} from "./harness/types";
import { DEFAULT_CONFIG, DEFAULT_STATE } from "./harness/config";
import {
  normalizeCryptoSymbol,
  isCryptoSymbol,
} from "./harness/utils";
import { fetchCrisisIndicators, evaluateCrisisLevel } from "./harness/crisis";
import * as dexTrading from "./harness/dex-trading";
import * as gatherers from "./harness/gatherers";
import * as twitter from "./harness/twitter";
import * as llmResearch from "./harness/llm-research";
import * as trading from "./harness/trading";
import * as options from "./harness/options";
import * as routes from "./harness/routes";

// Re-export for external use
export type { AgentConfig, AgentState, DexPosition, Signal };

// ============================================================================
// SECTION 3: DURABLE OBJECT CLASS
// ============================================================================
// The main agent class. Modify alarm() to change the core loop.
// Add new HTTP endpoints in fetch() for custom dashboard controls.
// ============================================================================

export class MahoragaHarness extends DurableObject<Env> {
  private state: AgentState = { ...DEFAULT_STATE };
  private _llm: LLMProvider | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this._llm = createLLMProvider(env);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${env.LLM_PROVIDER || "openai-raw"}`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured - research disabled");
    }

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<AgentState>("state");
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
        // Migrate config: replace null values with defaults from DEFAULT_CONFIG
        // This handles configs saved before new fields were added
        this.state.config = this.migrateConfig(stored.config);
        // Migrate other null fields to defaults (spread only handles undefined)
        if (this.state.dexPaperBalance == null || Number.isNaN(this.state.dexPaperBalance)) {
          this.state.dexPaperBalance = 1.0;
        }
        if (this.state.dexTradeHistory == null) this.state.dexTradeHistory = [];
        if (this.state.dexRealizedPnL == null || Number.isNaN(this.state.dexRealizedPnL)) {
          this.state.dexRealizedPnL = 0;
        }
        // Initialize streak and drawdown tracking fields (#15, #16, #17)
        if (this.state.dexMaxConsecutiveLosses == null) this.state.dexMaxConsecutiveLosses = 0;
        if (this.state.dexCurrentLossStreak == null) this.state.dexCurrentLossStreak = 0;
        if (this.state.dexMaxDrawdownPct == null) this.state.dexMaxDrawdownPct = 0;
        if (this.state.dexMaxDrawdownDuration == null) this.state.dexMaxDrawdownDuration = 0;
        if (this.state.dexDrawdownStartTime === undefined) this.state.dexDrawdownStartTime = null;
        if (this.state.dexPeakBalance == null || Number.isNaN(this.state.dexPeakBalance)) {
          this.state.dexPeakBalance = this.state.dexPaperBalance;
        }
        // Initialize crisis state if missing
        if (!this.state.crisisState) {
          this.state.crisisState = DEFAULT_STATE.crisisState;
        }
        if (this.state.lastCrisisCheck == null) {
          this.state.lastCrisisCheck = 0;
        }
      }
      this.initializeLLM();

      // Reschedule alarm if stale - in local dev, past alarms don't fire on restart;
      // in production this is a defensive check for edge cases (long inactivity, redeployments)
      if (this.state.enabled) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        const now = Date.now();
        if (!existingAlarm || existingAlarm < now) {
          await this.ctx.storage.setAlarm(now + 5_000);
        }
      }
    });
  }

  /**
   * Migrate config by replacing null values with defaults from DEFAULT_CONFIG.
   * This ensures configs saved before new fields were added get proper defaults.
   */
  private migrateConfig(storedConfig: Partial<AgentConfig>): AgentConfig {
    const migrated = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof AgentConfig)[]) {
      const storedValue = storedConfig[key];
      // Only use stored value if it's not null/undefined
      if (storedValue !== null && storedValue !== undefined) {
        (migrated as Record<string, unknown>)[key] = storedValue;
      }
    }
    return migrated;
  }

  private initializeLLM() {
    const provider = this.state.config.llm_provider || this.env.LLM_PROVIDER || "openai-raw";
    const model = this.state.config.llm_model || this.env.LLM_MODEL || "gpt-4o-mini";

    const effectiveEnv: Env = {
      ...this.env,
      LLM_PROVIDER: provider as Env["LLM_PROVIDER"],
      LLM_MODEL: model,
    };

    this._llm = createLLMProvider(effectiveEnv);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${provider} (${model})`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured");
    }
  }

  /**
   * Create a HarnessContext for module function calls.
   * This bundles all dependencies needed by extracted modules.
   */
  private getContext(): routes.RoutesContext {
    return {
      state: this.state,
      env: this.env,
      llm: this._llm,
      log: this.log.bind(this),
      persist: this.persist.bind(this),
      jsonResponse: this.jsonResponse.bind(this),
      initializeLLM: this.initializeLLM.bind(this),
      scheduleNextAlarm: this.scheduleNextAlarm.bind(this),
      deleteAlarm: async () => { await this.ctx.storage.deleteAlarm(); },
    };
  }

  // ============================================================================
  // [CUSTOMIZABLE] ALARM HANDLER - Main entry point for scheduled work
  // ============================================================================
  // This runs every 30 seconds. Modify to change:
  // - What runs and when (intervals, market hours checks)
  // - Order of operations (data → research → trading)
  // - Add new features (e.g., portfolio rebalancing, alerts)
  // ============================================================================

  async alarm(): Promise<void> {
    if (!this.state.enabled) {
      this.log("System", "alarm_skipped", { reason: "Agent not enabled" });
      return;
    }

    const now = Date.now();
    const RESEARCH_INTERVAL_MS = 120_000;
    const POSITION_RESEARCH_INTERVAL_MS = 300_000;

    try {
      const alpaca = createAlpacaProviders(this.env);
      const clock = await alpaca.trading.getClock();

      // Heartbeat log - shows what will run this cycle
      const willGatherData = now - this.state.lastDataGatherRun >= this.state.config.data_poll_interval_ms;
      const willResearch = now - this.state.lastResearchRun >= RESEARCH_INTERVAL_MS;
      const willAnalyst = clock.is_open && now - this.state.lastAnalystRun >= this.state.config.analyst_interval_ms;
      this.log("System", "alarm_heartbeat", {
        market: clock.is_open ? "OPEN" : "CLOSED",
        dex: this.state.config.dex_enabled ? "ON" : "off",
        crypto: this.state.config.crypto_enabled ? "ON" : "off",
        crisis: this.state.config.crisis_mode_enabled ? `L${this.state.crisisState.level}` : "off",
        phases: [
          willGatherData && "data",
          willResearch && "research",
          this.state.config.dex_enabled && "dex",
          willAnalyst && "analyst",
        ].filter(Boolean).join(",") || "none",
      });

      // ═══════════════════════════════════════════════════════════════════════
      // CRISIS MODE CHECK - Run before any trading logic
      // Monitors market stress indicators and takes protective actions
      // ═══════════════════════════════════════════════════════════════════════
      if (this.state.config.crisis_mode_enabled) {
        await this.runCrisisCheck();

        // If full crisis (level 3), execute emergency actions and skip normal trading
        if (this.isCrisisFullPanic()) {
          this.log("Crisis", "full_panic_mode", {
            message: "CRISIS LEVEL 3 - Halting all trading activities",
          });
          await this.executeCrisisActions(alpaca);
          await this.persist();
          await this.scheduleNextAlarm();
          return; // Skip all normal trading
        }

        // If high alert (level 2), execute protective actions but continue monitoring
        if (this.state.crisisState.level >= 2) {
          await this.executeCrisisActions(alpaca);
        }
      }
      // ═══════════════════════════════════════════════════════════════════════

      if (now - this.state.lastDataGatherRun >= this.state.config.data_poll_interval_ms) {
        this.log("System", "phase_start", { phase: "data_gather" });
        await this.runDataGatherers();
        this.state.lastDataGatherRun = now;
      }

      if (now - this.state.lastResearchRun >= RESEARCH_INTERVAL_MS) {
        this.log("System", "phase_start", { phase: "llm_research" });
        await llmResearch.researchTopSignals(this.getContext(), 5);
        this.state.lastResearchRun = now;
      }

      if (this.isPreMarketWindow() && !this.state.premarketPlan) {
        await this.runPreMarketAnalysis();
      }

      const positions = await alpaca.trading.getPositions();

      if (this.state.config.crypto_enabled) {
        await trading.runCryptoTrading(this.getContext(), alpaca, positions);
      }

      // DEX momentum trading (Solana tokens via DexScreener/Jupiter)
      if (this.state.config.dex_enabled) {
        this.log("System", "phase_start", { phase: "dex_trading" });
        await gatherers.gatherDexMomentum(this.getContext());
        await dexTrading.runDexTrading(this.getContext());
        // Always record snapshot when DEX is enabled (for chart history)
        await dexTrading.recordDexSnapshot(this.getContext());
      }

      if (clock.is_open) {
        if (this.isMarketJustOpened() && this.state.premarketPlan) {
          await this.executePremarketPlan();
        }

        if (now - this.state.lastAnalystRun >= this.state.config.analyst_interval_ms) {
          this.log("System", "phase_start", { phase: "analyst" });
          await trading.runAnalyst(this.getContext());
          this.state.lastAnalystRun = now;
        }

        if (positions.length > 0 && now - this.state.lastResearchRun >= POSITION_RESEARCH_INTERVAL_MS) {
          for (const pos of positions) {
            if (pos.asset_class !== "us_option") {
              await llmResearch.researchPosition(this.getContext(), pos.symbol, pos);
            }
          }
        }

        if (options.isOptionsEnabled(this.getContext())) {
          const optionsExits = await options.checkOptionsExits(this.getContext(), positions);
          for (const exit of optionsExits) {
            await trading.executeSell(this.getContext(), alpaca, exit.symbol, exit.reason);
          }
        }

        if (twitter.isTwitterEnabled(this.getContext())) {
          const heldSymbols = positions.map(p => p.symbol);
          const breakingNews = await twitter.checkTwitterBreakingNews(this.getContext(), heldSymbols);
          for (const news of breakingNews) {
            if (news.is_breaking) {
              this.log("System", "twitter_breaking_news", {
                symbol: news.symbol,
                headline: news.headline.slice(0, 100),
              });
            }
          }
        }
      }

      await this.persist();
      this.log("System", "alarm_complete", { durationMs: Date.now() - now });
    } catch (error) {
      this.log("System", "alarm_error", { error: String(error) });
    }

    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextRun = Date.now() + 30_000;  // 30 seconds
    await this.ctx.storage.setAlarm(nextRun);
  }

  // ============================================================================
  // HTTP HANDLER (for dashboard/control)
  // ============================================================================
  // Add new endpoints here for custom dashboard controls.
  // Example: /webhook for external alerts, /backtest for simulation
  // ============================================================================

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  private isAuthorized(request: Request): boolean {
    const token = this.env.MAHORAGA_API_TOKEN;
    if (!token) {
      console.warn("[MahoragaHarness] MAHORAGA_API_TOKEN not set - denying request");
      return false;
    }
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return false;
    }
    return this.constantTimeCompare(authHeader.slice(7), token);
  }

  private isKillSwitchAuthorized(request: Request): boolean {
    const secret = this.env.KILL_SWITCH_SECRET;
    if (!secret) {
      return false;
    }
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return false;
    }
    return this.constantTimeCompare(authHeader.slice(7), secret);
  }

  private unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Requires: Authorization: Bearer <MAHORAGA_API_TOKEN>" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    const protectedActions = ["enable", "disable", "config", "trigger", "status", "logs", "costs", "signals", "setup/status", "dex/reset", "dex/clear-cooldowns", "dex/clear-breaker", "crisis/toggle", "crisis/check"];
    if (protectedActions.includes(action)) {
      if (!this.isAuthorized(request)) {
        return this.unauthorizedResponse();
      }
    }

    try {
      switch (action) {
        case "status":
          return routes.handleStatus(this.getContext());

        case "setup/status":
          return this.jsonResponse({ ok: true, data: { configured: true } });

        case "config":
          if (request.method === "POST") {
            return routes.handleUpdateConfig(this.getContext(), request);
          }
          return this.jsonResponse({ ok: true, data: this.state.config });

        case "enable":
          return routes.handleEnable(this.getContext());

        case "disable":
          return routes.handleDisable(this.getContext());

        case "logs":
          return routes.handleGetLogs(this.getContext(), url);

        case "costs":
          return this.jsonResponse({ costs: this.state.costTracker });

        case "signals":
          return this.jsonResponse({ signals: this.state.signalCache });

        case "trigger":
          await this.alarm();
          return this.jsonResponse({ ok: true, message: "Alarm triggered" });

        case "kill":
          if (!this.isKillSwitchAuthorized(request)) {
            return new Response(
              JSON.stringify({ error: "Forbidden. Requires: Authorization: Bearer <KILL_SWITCH_SECRET>" }),
              { status: 403, headers: { "Content-Type": "application/json" } }
            );
          }
          return routes.handleKillSwitch(this.getContext());

        case "dex/reset":
          return routes.handleDexReset(this.getContext());

        case "dex/clear-cooldowns":
          return routes.handleDexClearCooldowns(this.getContext());

        case "dex/clear-breaker":
          return routes.handleDexClearBreaker(this.getContext());

        case "crisis/toggle":
          return routes.handleCrisisToggle(this.getContext(), request);

        case "crisis/check":
          // Force an immediate crisis indicator check
          await this.runCrisisCheck();
          await this.persist();
          return this.jsonResponse({
            ok: true,
            crisisState: this.state.crisisState,
          });

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }


  // ============================================================================
  // SECTION 4: DATA GATHERING
  // ============================================================================
  // [CUSTOMIZABLE] This is where you add NEW DATA SOURCES.
  // 
  // To add a new source:
  // 1. Create a new gather method (e.g., gatherNewsAPI)
  // 2. Add it to runDataGatherers() Promise.all
  // 3. Add source weight to SOURCE_CONFIG.weights
  // 4. Return Signal[] with your source name
  //
  // Each gatherer returns Signal[] which get merged into signalCache.
  // ============================================================================

  private async runDataGatherers(): Promise<void> {
    return gatherers.runDataGatherers(this.getContext());
  }

  // ============================================================================
  // SECTION 5: TWITTER INTEGRATION
  // ============================================================================
  // [TOGGLE] Enable with TWITTER_BEARER_TOKEN secret
  // [TUNE] MAX_DAILY_READS controls API budget (default: 200/day)
  // 
  // Twitter is used for CONFIRMATION only - it boosts/reduces confidence
  // on signals from other sources, doesn't generate signals itself.
  // ============================================================================

  // SECTION 7: ANALYST & TRADING LOGIC
  // ============================================================================
  // [CUSTOMIZABLE] Core trading decision logic lives here.
  //
  // runAnalyst(): Main trading loop - checks exits, then looks for entries
  // executeBuy(): Position sizing and order execution
  // executeSell(): Closes positions with reason logging
  //
  // [TUNE] Position sizing formula in executeBuy()
  // [TUNE] Entry/exit conditions in runAnalyst()
  // ============================================================================

  private async executeBuy(
    alpaca: ReturnType<typeof createAlpacaProviders>,
    symbol: string,
    confidence: number,
    account: Account
  ): Promise<boolean> {
    // Crisis mode check - block new entries during high alert
    if (this.isCrisisBlockingEntries()) {
      this.log("Executor", "buy_blocked", {
        symbol,
        reason: "CRISIS_MODE_BLOCKING",
        crisisLevel: this.state.crisisState.level,
        triggered: this.state.crisisState.triggeredIndicators,
      });
      return false;
    }

    if (!symbol || symbol.trim().length === 0) {
      this.log("Executor", "buy_blocked", { reason: "INVARIANT: Empty symbol" });
      return false;
    }

    if (account.cash <= 0) {
      this.log("Executor", "buy_blocked", { symbol, reason: "INVARIANT: No cash available", cash: account.cash });
      return false;
    }

    if (confidence <= 0 || confidence > 1 || !Number.isFinite(confidence)) {
      this.log("Executor", "buy_blocked", { symbol, reason: "INVARIANT: Invalid confidence", confidence });
      return false;
    }

    const sizePct = Math.min(20, this.state.config.position_size_pct_of_cash);
    const crisisMultiplier = this.getCrisisPositionMultiplier();
    const positionSize = Math.min(
      account.cash * (sizePct / 100) * confidence * crisisMultiplier,
      this.state.config.max_position_value * crisisMultiplier
    );

    if (crisisMultiplier < 1.0) {
      this.log("Executor", "crisis_size_reduction", {
        symbol,
        crisisLevel: this.state.crisisState.level,
        multiplier: crisisMultiplier,
      });
    }

    if (positionSize < 10) {
      this.log("Executor", "buy_skipped", { symbol, reason: "Position too small" });
      return false;
    }

    const maxAllowed = this.state.config.max_position_value * 1.01;
    if (positionSize <= 0 || positionSize > maxAllowed || !Number.isFinite(positionSize)) {
      this.log("Executor", "buy_blocked", {
        symbol,
        reason: "INVARIANT: Invalid position size",
        positionSize,
        maxAllowed,
      });
      return false;
    }

    try {
      const isCrypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
      const orderSymbol = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;
      const timeInForce = isCrypto ? "gtc" : "day";

      if (!isCrypto) {
        const allowedExchanges = this.state.config.allowed_exchanges ?? ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"];
        if (allowedExchanges.length > 0) {
          const asset = await alpaca.trading.getAsset(symbol);
          if (!asset) {
            this.log("Executor", "buy_blocked", { symbol, reason: "Asset not found" });
            return false;
          }
          if (!allowedExchanges.includes(asset.exchange)) {
            this.log("Executor", "buy_blocked", { 
              symbol, 
              reason: "Exchange not allowed (OTC/foreign stocks have data issues)",
              exchange: asset.exchange,
              allowedExchanges 
            });
            return false;
          }
        }
      }

      const order = await alpaca.trading.createOrder({
        symbol: orderSymbol,
        notional: Math.round(positionSize * 100) / 100,
        side: "buy",
        type: "market",
        time_in_force: timeInForce,
      });

      this.log("Executor", "buy_executed", { symbol: orderSymbol, isCrypto, status: order.status, size: positionSize });
      return true;
    } catch (error) {
      this.log("Executor", "buy_failed", { symbol, error: String(error) });
      return false;
    }
  }

  private async executeSell(
    alpaca: ReturnType<typeof createAlpacaProviders>,
    symbol: string,
    reason: string
  ): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      this.log("Executor", "sell_blocked", { reason: "INVARIANT: Empty symbol" });
      return false;
    }

    if (!reason || reason.trim().length === 0) {
      this.log("Executor", "sell_blocked", { symbol, reason: "INVARIANT: No sell reason provided" });
      return false;
    }

    // PDT Protection: Check if this would be a day trade on an account under $25k
    const isCrypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
    if (!isCrypto) {
      const entry = this.state.positionEntries[symbol];
      if (entry) {
        const entryDate = new Date(entry.entry_time).toDateString();
        const today = new Date().toDateString();
        const isSameDaySell = entryDate === today;

        if (isSameDaySell) {
          try {
            const account = await alpaca.trading.getAccount();
            const PDT_EQUITY_THRESHOLD = 25000;
            const PDT_TRADE_LIMIT = 3;

            if (account.equity < PDT_EQUITY_THRESHOLD && account.daytrade_count >= PDT_TRADE_LIMIT) {
              this.log("Executor", "sell_blocked_pdt", {
                symbol,
                reason: "PDT protection: Would exceed day trade limit",
                equity: account.equity,
                daytrade_count: account.daytrade_count,
                original_reason: reason,
              });
              return false;
            }

            // Warn if approaching PDT limit
            if (account.equity < PDT_EQUITY_THRESHOLD && account.daytrade_count >= 2) {
              this.log("Executor", "pdt_warning", {
                symbol,
                message: `Day trade ${account.daytrade_count + 1}/3 - approaching PDT limit`,
                equity: account.equity,
              });
            }
          } catch (e) {
            // If we can't check account, allow the trade but log warning
            this.log("Executor", "pdt_check_failed", { symbol, error: String(e) });
          }
        }
      }
    }

    try {
      await alpaca.trading.closePosition(symbol);
      this.log("Executor", "sell_executed", { symbol, reason });

      delete this.state.positionEntries[symbol];
      delete this.state.socialHistory[symbol];
      delete this.state.stalenessAnalysis[symbol];

      return true;
    } catch (error) {
      this.log("Executor", "sell_failed", { symbol, error: String(error) });
      return false;
    }
  }

  // ============================================================================
  // SECTION 8: STALENESS DETECTION
  // ============================================================================
  // [TOGGLE] Enable with stale_position_enabled in config
  // [TUNE] Staleness thresholds (hold time, volume decay, gain requirements)
  //
  // Staleness = positions that lost momentum. Scored 0-100 based on:
  // - Time held (vs max hold days)
  // - Price action (P&L vs targets)
  // - Social volume decay (vs entry volume)
  // ============================================================================

  // ============================================================================
  // SECTION 10: PRE-MARKET ANALYSIS
  // ============================================================================
  // Runs 9:25-9:29 AM ET to prepare a trading plan before market open.
  // Executes the plan at 9:30-9:32 AM when market opens.
  //
  // [TUNE] Change time windows in isPreMarketWindow() / isMarketJustOpened()
  // [TUNE] Plan staleness (PLAN_STALE_MS) in executePremarketPlan()
  // ============================================================================

  private isPreMarketWindow(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const day = now.getDay();

    if (day >= 1 && day <= 5) {
      if (hour === 9 && minute >= 25 && minute <= 29) {
        return true;
      }
    }
    return false;
  }

  private isMarketJustOpened(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const day = now.getDay();

    if (day >= 1 && day <= 5) {
      if (hour === 9 && minute >= 30 && minute <= 32) {
        return true;
      }
    }
    return false;
  }

  private async runPreMarketAnalysis(): Promise<void> {
    const alpaca = createAlpacaProviders(this.env);
    const [account, positions] = await Promise.all([
      alpaca.trading.getAccount(),
      alpaca.trading.getPositions(),
    ]);

    if (!account || this.state.signalCache.length === 0) return;

    this.log("System", "premarket_analysis_starting", {
      signals: this.state.signalCache.length,
      researched: Object.keys(this.state.signalResearch).length,
    });

    const signalResearch = await llmResearch.researchTopSignals(this.getContext(), 10);
    const analysis = await llmResearch.analyzeSignalsWithLLM(this.getContext(), this.state.signalCache, positions, account);

    this.state.premarketPlan = {
      timestamp: Date.now(),
      recommendations: analysis.recommendations.map(r => ({
        action: r.action,
        symbol: r.symbol,
        confidence: r.confidence,
        reasoning: r.reasoning,
        suggested_size_pct: r.suggested_size_pct,
      })),
      market_summary: analysis.market_summary,
      high_conviction: analysis.high_conviction,
      researched_buys: signalResearch.filter(r => r.verdict === "BUY"),
    };

    const buyRecs = this.state.premarketPlan.recommendations.filter(r => r.action === "BUY").length;
    const sellRecs = this.state.premarketPlan.recommendations.filter(r => r.action === "SELL").length;

    this.log("System", "premarket_analysis_complete", {
      buy_recommendations: buyRecs,
      sell_recommendations: sellRecs,
      high_conviction: this.state.premarketPlan.high_conviction,
    });
  }

  private async executePremarketPlan(): Promise<void> {
    const PLAN_STALE_MS = 600_000;

    if (!this.state.premarketPlan || Date.now() - this.state.premarketPlan.timestamp > PLAN_STALE_MS) {
      this.log("System", "no_premarket_plan", { reason: "Plan missing or stale" });
      return;
    }

    const alpaca = createAlpacaProviders(this.env);
    const [account, positions] = await Promise.all([
      alpaca.trading.getAccount(),
      alpaca.trading.getPositions(),
    ]);

    if (!account) return;

    const heldSymbols = new Set(positions.map(p => p.symbol));

    this.log("System", "executing_premarket_plan", {
      recommendations: this.state.premarketPlan.recommendations.length,
    });

    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "SELL" && rec.confidence >= this.state.config.min_analyst_confidence) {
        await this.executeSell(alpaca, rec.symbol, `Pre-market plan: ${rec.reasoning}`);
      }
    }

    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "BUY" && rec.confidence >= this.state.config.min_analyst_confidence) {
        if (heldSymbols.has(rec.symbol)) continue;
        if (positions.length >= this.state.config.max_positions) break;

        const result = await this.executeBuy(alpaca, rec.symbol, rec.confidence, account);
        if (result) {
          heldSymbols.add(rec.symbol);

          const originalSignal = this.state.signalCache.find(s => s.symbol === rec.symbol);
          this.state.positionEntries[rec.symbol] = {
            symbol: rec.symbol,
            entry_time: Date.now(),
            entry_price: 0,
            entry_sentiment: originalSignal?.sentiment || 0,
            entry_social_volume: originalSignal?.volume || 0,
            entry_sources: originalSignal?.subreddits || [originalSignal?.source || "premarket"],
            entry_reason: rec.reasoning,
            peak_price: 0,
            peak_sentiment: originalSignal?.sentiment || 0,
          };
        }
      }
    }

    this.state.premarketPlan = null;
  }

  // ============================================================================
  // SECTION 10.5: CRISIS MODE - BLACK SWAN PROTECTION
  // ============================================================================
  // Monitor market stress indicators and protect portfolio during crises.
  // Runs alongside normal trading - you keep making money until crisis hits,
  // then auto-protective measures kick in based on severity level.
  // ============================================================================

  /**
   * Run crisis indicator check - called periodically from alarm handler
   * Fetches indicators, evaluates crisis level, and takes protective actions
   */
  private async runCrisisCheck(): Promise<void> {
    const config = this.state.config;
    if (!config.crisis_mode_enabled) return;

    // Manual override check
    if (this.state.crisisState.manualOverride) {
      this.log("Crisis", "manual_override_active", {
        level: this.state.crisisState.level,
      });
      return;
    }

    const now = Date.now();
    const checkInterval = config.crisis_check_interval_ms || 300_000;

    // Only check if enough time has passed
    if (now - this.state.lastCrisisCheck < checkInterval) {
      return;
    }

    this.log("Crisis", "checking_indicators", {});

    try {
      // Fetch all indicators concurrently (pass FRED API key if available)
      const fredApiKey = (this.env as unknown as Record<string, string>).FRED_API_KEY;
      const indicators = await fetchCrisisIndicators(fredApiKey);
      this.state.crisisState.indicators = indicators;
      this.state.lastCrisisCheck = now;

      // Evaluate crisis level
      const { level, triggeredIndicators } = evaluateCrisisLevel(indicators, config);
      const previousLevel = this.state.crisisState.level;

      // Update state
      this.state.crisisState.level = level;
      this.state.crisisState.triggeredIndicators = triggeredIndicators;

      // Log level changes
      if (level !== previousLevel) {
        this.state.crisisState.lastLevelChange = now;
        const levelNames = ["NORMAL", "ELEVATED", "HIGH ALERT", "FULL CRISIS"];
        this.log("Crisis", "level_changed", {
          previous: levelNames[previousLevel],
          current: levelNames[level],
          triggered: triggeredIndicators,
          indicators: {
            vix: indicators.vix,
            hySpread: indicators.highYieldSpread,
            btc: indicators.btcPrice,
            btcWeekly: indicators.btcWeeklyChange,
            usdt: indicators.stablecoinPeg,
            gsRatio: indicators.goldSilverRatio,
          },
        });

        // Send Discord notification for significant level changes
        if (level >= 2 || (level === 1 && previousLevel === 0)) {
          await this.sendCrisisDiscordNotification(
            `🚨 CRISIS LEVEL: ${levelNames[level]}`,
            `Triggered indicators:\n${triggeredIndicators.join("\n")}`,
            level >= 2 ? 0xFF0000 : 0xFFA500 // Red for crisis, orange for elevated
          );
        }
      }

      // Log current status
      this.log("Crisis", "status", {
        level,
        triggered: triggeredIndicators.length,
        vix: indicators.vix?.toFixed(1) ?? "N/A",
        btc: indicators.btcPrice?.toFixed(0) ?? "N/A",
      });

    } catch (error) {
      this.log("Crisis", "check_error", { error: String(error) });
    }
  }

  /**
   * Check if crisis mode is blocking new entries
   * Returns true if new positions should NOT be opened
   */
  private isCrisisBlockingEntries(): boolean {
    if (!this.state.config.crisis_mode_enabled) return false;
    if (this.state.crisisState.manualOverride) return false;

    // Level 2+ blocks new entries
    return this.state.crisisState.level >= 2;
  }

  /**
   * Check if crisis mode is blocking ALL trading (full crisis)
   * Returns true if we should close all positions immediately
   */
  private isCrisisFullPanic(): boolean {
    if (!this.state.config.crisis_mode_enabled) return false;
    if (this.state.crisisState.manualOverride) return false;

    // Level 3 = full crisis, close everything
    return this.state.crisisState.level >= 3;
  }

  /**
   * Get adjusted position size for current crisis level
   * Returns multiplier (0.0 to 1.0) to apply to position sizes
   */
  private getCrisisPositionMultiplier(): number {
    if (!this.state.config.crisis_mode_enabled) return 1.0;
    if (this.state.crisisState.manualOverride) return 1.0;

    const level = this.state.crisisState.level;
    switch (level) {
      case 0: return 1.0;       // Normal - full size
      case 1: return 0.5;       // Elevated - half size
      case 2: return 0.0;       // High alert - no new positions
      case 3: return 0.0;       // Full crisis - no new positions
      default: return 1.0;
    }
  }

  /**
   * Get adjusted stop loss for current crisis level
   * Returns tighter stop loss percentage during elevated risk
   */
  /**
   * Get adjusted stop loss for current crisis level
   * Returns tighter stop loss percentage during elevated risk
   * @internal Reserved for future integration with position management
   */
  public getCrisisAdjustedStopLoss(normalStopLoss: number): number {
    if (!this.state.config.crisis_mode_enabled) return normalStopLoss;
    if (this.state.crisisState.manualOverride) return normalStopLoss;

    const level = this.state.crisisState.level;
    const config = this.state.config;

    switch (level) {
      case 0: return normalStopLoss;
      case 1: return Math.min(normalStopLoss, config.crisis_level1_stop_loss_pct);
      case 2: return Math.min(normalStopLoss, config.crisis_level1_stop_loss_pct * 0.8); // Even tighter
      case 3: return 0; // Sell immediately
      default: return normalStopLoss;
    }
  }

  /**
   * Execute crisis protection actions based on current level
   * Called after crisis check detects elevated levels
   */
  private async executeCrisisActions(alpaca: ReturnType<typeof createAlpacaProviders>): Promise<void> {
    const level = this.state.crisisState.level;
    if (level === 0) return;

    const levelNames = ["NORMAL", "ELEVATED", "HIGH ALERT", "FULL CRISIS"];
    this.log("Crisis", "executing_actions", { level: levelNames[level] });

    try {
      const positions = await alpaca.trading.getPositions();

      if (level >= 3) {
        // FULL CRISIS: Close ALL positions immediately
        this.log("Crisis", "full_crisis_liquidation", {
          positions: positions.length,
        });

        for (const pos of positions) {
          try {
            await this.executeSell(alpaca, pos.symbol, "CRISIS_LEVEL_3_LIQUIDATION");
            this.state.crisisState.positionsClosedInCrisis.push(pos.symbol);
          } catch (err) {
            this.log("Crisis", "liquidation_error", { symbol: pos.symbol, error: String(err) });
          }
        }

        // Also close DEX positions
        await this.closeAllDexPositions("CRISIS_LEVEL_3_LIQUIDATION");

        await this.sendCrisisDiscordNotification(
          "🚨 FULL CRISIS - ALL POSITIONS LIQUIDATED",
          `Closed ${positions.length} stock positions and all DEX positions`,
          0xFF0000
        );

      } else if (level >= 2) {
        // HIGH ALERT: Close losing positions, keep winners with trailing stops
        const config = this.state.config;
        const minProfitToHold = config.crisis_level2_min_profit_to_hold;

        for (const pos of positions) {
          const plPct = pos.unrealized_plpc * 100;

          if (plPct < minProfitToHold) {
            this.log("Crisis", "closing_underwater_position", {
              symbol: pos.symbol,
              plPct: plPct.toFixed(2),
              threshold: minProfitToHold,
            });

            try {
              await this.executeSell(alpaca, pos.symbol, `CRISIS_LEVEL_2_UNDERWATER_${plPct.toFixed(1)}PCT`);
              this.state.crisisState.positionsClosedInCrisis.push(pos.symbol);
            } catch (err) {
              this.log("Crisis", "close_error", { symbol: pos.symbol, error: String(err) });
            }
          }
        }
      }
      // Level 1: Just reduces position sizes and tightens stops (handled elsewhere)

    } catch (error) {
      this.log("Crisis", "action_error", { error: String(error) });
    }
  }

  /**
   * Close all DEX positions during crisis
   */
  private async closeAllDexPositions(reason: string): Promise<void> {
    const positions = Object.values(this.state.dexPositions);
    if (positions.length === 0) return;

    this.log("Crisis", "closing_all_dex_positions", {
      count: positions.length,
      reason,
    });

    for (const pos of positions) {
      // Find current signal for price
      const signal = this.state.dexSignals.find(s => s.tokenAddress === pos.tokenAddress);
      const currentPrice = signal?.priceUsd ?? pos.entryPrice;

      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const exitValue = (currentPrice / pos.entryPrice) * pos.entrySol;
      const pnlSol = exitValue - pos.entrySol;

      // Record trade
      this.state.dexTradeHistory.push({
        symbol: pos.symbol,
        tokenAddress: pos.tokenAddress,
        entryPrice: pos.entryPrice,
        exitPrice: currentPrice,
        entrySol: pos.entrySol,
        entryTime: pos.entryTime,
        exitTime: Date.now(),
        pnlPct,
        pnlSol,
        exitReason: "manual",
      });

      // Update balance
      this.state.dexPaperBalance += exitValue;
      this.state.dexRealizedPnL += pnlSol;

      // Remove position
      delete this.state.dexPositions[pos.tokenAddress];

      this.log("Crisis", "dex_position_closed", {
        symbol: pos.symbol,
        pnlPct: pnlPct.toFixed(2),
        pnlSol: pnlSol.toFixed(4),
        reason,
      });
    }
  }

  // ============================================================================
  // SECTION 11: UTILITIES
  // ============================================================================
  // Logging, cost tracking, persistence, and Discord notifications.
  // Generally don't need to modify unless adding new notification channels.
  // ============================================================================

  private log(agent: string, action: string, details: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      agent,
      action,
      ...details,
    };
    this.state.logs.push(entry);

    // Keep last 500 logs
    if (this.state.logs.length > 500) {
      this.state.logs = this.state.logs.slice(-500);
    }

    // Log to console for wrangler tail
    console.log(`[${entry.timestamp}] [${agent}] ${action}`, JSON.stringify(details));
  }

  public trackLLMCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
      "gpt-4o": { input: 2.5, output: 10 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
    };

    const rates = pricing[model] ?? pricing["gpt-4o"]!;
    const cost = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;

    this.state.costTracker.total_usd += cost;
    this.state.costTracker.calls++;
    this.state.costTracker.tokens_in += tokensIn;
    this.state.costTracker.tokens_out += tokensOut;

    return cost;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }


  get llm(): LLMProvider | null {
    return this._llm;
  }

  private discordCooldowns: Map<string, number> = new Map();

  /**
   * Send a crisis-specific Discord notification with custom title/description/color
   */
  private async sendCrisisDiscordNotification(
    title: string,
    description: string,
    color: number
  ): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL) return;

    // Rate limit crisis notifications to once per 5 minutes per crisis level
    const cacheKey = `crisis_${this.state.crisisState.level}`;
    const lastNotification = this.discordCooldowns.get(cacheKey);
    if (lastNotification && Date.now() - lastNotification < 5 * 60 * 1000) {
      return;
    }

    try {
      const embed = {
        title,
        description,
        color,
        fields: [
          { name: "Crisis Level", value: String(this.state.crisisState.level), inline: true },
          { name: "VIX", value: this.state.crisisState.indicators.vix?.toFixed(1) ?? "N/A", inline: true },
          { name: "BTC", value: this.state.crisisState.indicators.btcPrice ? `$${this.state.crisisState.indicators.btcPrice.toFixed(0)}` : "N/A", inline: true },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "MAHORAGA Crisis Monitor" },
      };

      await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      this.discordCooldowns.set(cacheKey, Date.now());
      this.log("Discord", "crisis_notification_sent", { title, level: this.state.crisisState.level });
    } catch (err) {
      this.log("Discord", "crisis_notification_failed", { error: String(err) });
    }
  }
}

// ============================================================================
// SECTION 12: EXPORTS & HELPERS
// ============================================================================
// Helper functions to interact with the DO from your worker.
// ============================================================================

export function getHarnessStub(env: Env): DurableObjectStub {
  if (!env.MAHORAGA_HARNESS) {
    throw new Error("MAHORAGA_HARNESS binding not configured - check wrangler.toml");
  }
  const id = env.MAHORAGA_HARNESS.idFromName("main");
  return env.MAHORAGA_HARNESS.get(id);
}

export async function getHarnessStatus(env: Env): Promise<unknown> {
  const stub = getHarnessStub(env);
  const response = await stub.fetch(new Request("http://harness/status"));
  return response.json();
}

export async function enableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/enable"));
}

export async function disableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/disable"));
}
