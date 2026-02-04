/**
 * Jupiter Aggregator Provider
 *
 * Executes swaps on Solana via Jupiter's API.
 * Requires a Solana wallet (private key) to sign transactions.
 */

// Note: Full implementation requires @solana/web3.js
// For now, we'll create the structure and API calls

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

export interface JupiterSwapResult {
  success: boolean;
  signature?: string;
  error?: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
}

const JUPITER_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export class JupiterProvider {
  private walletPublicKey?: string;

  constructor(publicKey?: string) {
    this.walletPublicKey = publicKey;
  }

  /**
   * Get a quote for swapping tokens
   */
  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: number; // in lamports or smallest unit
    slippageBps?: number;
  }): Promise<JupiterQuote> {
    const { inputMint, outputMint, amount, slippageBps = 50 } = params;

    const url = new URL(`${JUPITER_API}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("slippageBps", slippageBps.toString());

    const res = await fetch(url.toString());
    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Jupiter quote error: ${error}`);
    }

    return res.json();
  }

  /**
   * Get quote for buying a token with SOL
   */
  async getQuoteBuyWithSol(params: {
    tokenMint: string;
    solAmount: number; // in SOL (not lamports)
    slippageBps?: number;
  }): Promise<JupiterQuote> {
    const lamports = Math.floor(params.solAmount * 1e9);
    return this.getQuote({
      inputMint: SOL_MINT,
      outputMint: params.tokenMint,
      amount: lamports,
      slippageBps: params.slippageBps,
    });
  }

  /**
   * Get quote for selling a token to SOL
   */
  async getQuoteSellToSol(params: {
    tokenMint: string;
    tokenAmount: number; // in smallest unit
    decimals?: number;
    slippageBps?: number;
  }): Promise<JupiterQuote> {
    return this.getQuote({
      inputMint: params.tokenMint,
      outputMint: SOL_MINT,
      amount: params.tokenAmount,
      slippageBps: params.slippageBps,
    });
  }

  /**
   * Get swap transaction (requires wallet to sign)
   * Returns serialized transaction that needs to be signed and sent
   */
  async getSwapTransaction(quote: JupiterQuote): Promise<string> {
    if (!this.walletPublicKey) {
      throw new Error("Wallet public key required for swap transaction");
    }

    const res = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.walletPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Jupiter swap error: ${error}`);
    }

    const data = await res.json() as { swapTransaction: string };
    return data.swapTransaction;
  }

  /**
   * Estimate price impact and output for a swap
   */
  async estimateSwap(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
  }): Promise<{
    outputAmount: number;
    priceImpactPct: number;
    route: string[];
  }> {
    const quote = await this.getQuote({
      ...params,
      slippageBps: 100, // 1% for estimation
    });

    return {
      outputAmount: parseInt(quote.outAmount),
      priceImpactPct: parseFloat(quote.priceImpactPct),
      route: quote.routePlan.map(r => r.swapInfo.label),
    };
  }

  /**
   * Get token price in SOL
   */
  async getTokenPriceInSol(tokenMint: string): Promise<number> {
    try {
      // Get quote for 1 token -> SOL
      const quote = await this.getQuote({
        inputMint: tokenMint,
        outputMint: SOL_MINT,
        amount: 1e9, // Assume 9 decimals, adjust as needed
        slippageBps: 100,
      });

      const solAmount = parseInt(quote.outAmount) / 1e9;
      return solAmount;
    } catch {
      return 0;
    }
  }

  /**
   * Check if a swap is viable (has liquidity, reasonable price impact)
   */
  async isSwapViable(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    maxPriceImpactPct?: number;
  }): Promise<{ viable: boolean; reason?: string; priceImpact?: number }> {
    const maxImpact = params.maxPriceImpactPct || 5;

    try {
      const quote = await this.getQuote({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: 100,
      });

      const priceImpact = parseFloat(quote.priceImpactPct);

      if (priceImpact > maxImpact) {
        return {
          viable: false,
          reason: `Price impact too high: ${priceImpact.toFixed(2)}%`,
          priceImpact,
        };
      }

      if (parseInt(quote.outAmount) === 0) {
        return {
          viable: false,
          reason: "No liquidity for this swap",
        };
      }

      return { viable: true, priceImpact };
    } catch (e) {
      return {
        viable: false,
        reason: `Quote failed: ${e}`,
      };
    }
  }
}

export function createJupiterProvider(walletPublicKey?: string): JupiterProvider {
  return new JupiterProvider(walletPublicKey);
}

// Helper to convert SOL to lamports
export function solToLamports(sol: number): number {
  return Math.floor(sol * 1e9);
}

// Helper to convert lamports to SOL
export function lamportsToSol(lamports: number): number {
  return lamports / 1e9;
}
