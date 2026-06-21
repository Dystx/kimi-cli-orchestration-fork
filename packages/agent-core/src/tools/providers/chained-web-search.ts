/**
 * ChainedWebSearchProvider — host-side `WebSearchProvider`.
 *
 * Tries each child provider in order, returning the first successful response.
 * A provider "succeeds" when it returns ≥1 result. An empty list is treated
 * as a soft failure and triggers the next provider so the user sees results
 * from whichever backend has coverage for the query. Hard exceptions from
 * one provider are caught and the next is attempted; the last error is
 * re-thrown only if every provider fails.
 *
 * Used to compose the default `WebSearch` tool from both Moonshot and
 * MiniMax providers when both are configured, and to power the
 * `WebSearchMinimax` second tool that explicitly targets MiniMax.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

export class ChainedWebSearchProvider implements WebSearchProvider {
  constructor(
    private readonly providers: readonly {
      readonly provider: WebSearchProvider;
      readonly name: string;
    }[],
  ) {
    if (providers.length === 0) {
      throw new Error('ChainedWebSearchProvider requires at least one provider.');
    }
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string },
  ): Promise<WebSearchResult[]> {
    const errors: Error[] = [];

    for (const { provider, name } of this.providers) {
      try {
        const results = await provider.search(query, options);
        if (results.length > 0) {
          return results;
        }
        // Soft miss: try the next provider so the user gets results from
        // whichever backend covers this query.
      } catch (error) {
        errors.push(
          error instanceof Error
            ? new Error(`[${name}] ${error.message}`)
            : new Error(`[${name}] ${String(error)}`),
        );
      }
    }

    if (errors.length > 0) {
      const summary = errors.map((e) => e.message).join('; ');
      throw new Error(
        `All web search providers failed for query "${query}". ${summary}`,
      );
    }

    // Every provider returned an empty result list — surface that as "no
    // results" rather than an error so the tool renders the standard
    // "No search results found." message.
    return [];
  }
}
