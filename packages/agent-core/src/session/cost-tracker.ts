import type { TokenUsage } from '@moonshot-ai/kosong';
import { inputTotal } from '@moonshot-ai/kosong';

/**
 * Rough per-million-token pricing in USD.
 * These are ballpark figures; override via setModelPricing for accuracy.
 */
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  'kimi-k2-5': { input: 0.5, output: 2.0 },
  'kimi-k2': { input: 0.5, output: 2.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};

export interface CostBudget {
  readonly maxDollars: number;
  readonly warnAtFraction?: number | undefined;
}

export interface CostStatus {
  readonly totalDollars: number;
  readonly byModel: Record<string, { tokens: number; dollars: number }>;
  readonly budget?: CostBudget | undefined;
  readonly remainingDollars?: number | undefined;
  readonly fractionUsed?: number | undefined;
}

/**
 * Lightweight cost tracker for the session.
 *
 * Accumulates estimated API spend based on token usage and per-model pricing.
 * Supports setting a session budget with automatic warn/alert thresholds.
 */
export class SessionCostTracker {
  private readonly byModel = new Map<string, { input: number; output: number }>();
  private budget: CostBudget | undefined;
  private pricing: Record<string, { input: number; output: number }> = { ...DEFAULT_PRICING };
  private warned = false;

  setBudget(budget: CostBudget): void {
    this.budget = budget;
    this.warned = false;
  }

  getBudget(): CostBudget | undefined {
    return this.budget;
  }

  setModelPricing(model: string, inputPerMillion: number, outputPerMillion: number): void {
    this.pricing[model] = { input: inputPerMillion, output: outputPerMillion };
  }

  record(model: string, usage: TokenUsage): void {
    const current = this.byModel.get(model) ?? { input: 0, output: 0 };
    this.byModel.set(model, {
      input: current.input + inputTotal(usage),
      output: current.output + usage.output,
    });
  }

  status(): CostStatus {
    const byModel: CostStatus['byModel'] = {};
    let totalDollars = 0;

    for (const [model, tokens] of this.byModel) {
      const price = this.pricing[model] ?? this.pricing['kimi-k2-5'] ?? { input: 1, output: 3 };
      const dollars =
        (tokens.input / 1_000_000) * price.input + (tokens.output / 1_000_000) * price.output;
      byModel[model] = { tokens: tokens.input + tokens.output, dollars };
      totalDollars += dollars;
    }

    const result: CostStatus = {
      totalDollars: Math.round(totalDollars * 10000) / 10000,
      byModel,
      budget: this.budget,
      remainingDollars:
        this.budget !== undefined ? Math.max(0, this.budget.maxDollars - totalDollars) : undefined,
      fractionUsed: this.budget !== undefined ? totalDollars / this.budget.maxDollars : undefined,
    };

    return result;
  }

  /**
   * Check if the budget has been exceeded or warning threshold crossed.
   * Returns the alert level and a message if applicable.
   */
  checkBudget(): { level: 'none' | 'warn' | 'exceeded'; message?: string } {
    if (this.budget === undefined) return { level: 'none' };
    const status = this.status();
    const fraction = status.fractionUsed ?? 0;

    if (fraction >= 1) {
      return {
        level: 'exceeded',
        message: `Session cost budget exceeded: $${status.totalDollars.toFixed(4)} / $${this.budget.maxDollars.toFixed(2)}`,
      };
    }

    const warnAt = this.budget.warnAtFraction ?? 0.8;
    if (!this.warned && fraction >= warnAt) {
      this.warned = true;
      return {
        level: 'warn',
        message: `Session cost budget warning: $${status.totalDollars.toFixed(4)} / $${this.budget.maxDollars.toFixed(2)} (${Math.round(fraction * 100)}%)`,
      };
    }

    return { level: 'none' };
  }
}
