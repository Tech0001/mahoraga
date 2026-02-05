/**
 * HarnessContext - Shared dependency injection context for all harness modules
 *
 * This pattern allows us to extract class methods into standalone functions
 * while maintaining access to shared state, environment, and utilities.
 */

import type { Env } from "../../env.d";
import type { AgentState } from "./types";
import type { LLMProvider } from "../../providers/types";

/**
 * Context object passed to all extracted module functions.
 * Contains everything a module needs to operate.
 */
export interface HarnessContext {
  /** Current agent state (positions, config, signals, etc.) */
  state: AgentState;

  /** Cloudflare Worker environment bindings (secrets, KV, etc.) */
  env: Env;

  /** LLM provider for AI-powered analysis (may be null if not configured) */
  llm: LLMProvider | null;

  /** Structured logging function */
  log: (agent: string, action: string, details: Record<string, unknown>) => void;

  /** Persist state to durable storage */
  persist: () => Promise<void>;

  /** Create a JSON response */
  jsonResponse: (data: unknown) => Response;
}

/**
 * Extended context for modules that need Discord notifications
 */
export interface HarnessContextWithDiscord extends HarnessContext {
  /** Send a Discord notification (with cooldown management) */
  sendDiscordNotification: (
    type: string,
    title: string,
    description: string,
    fields?: Array<{ name: string; value: string; inline?: boolean }>,
    color?: number
  ) => Promise<void>;
}
