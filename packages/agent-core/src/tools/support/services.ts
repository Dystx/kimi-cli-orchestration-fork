import type { ImageSearchProvider, UrlFetcher, WebSearchProvider } from '../builtin';

export interface ExtraWebSearcher {
  readonly name: string;
  readonly provider: WebSearchProvider;
  readonly description: string;
}

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher;
  readonly webSearcher?: WebSearchProvider;
  readonly imageSearcher?: ImageSearchProvider;
  /**
   * Additional named web-search providers that should be registered as
   * dedicated tools (e.g. `WebSearchMinimax`) alongside the default
   * `WebSearch` tool. The default tool itself is backed by
   * `webSearcher`; these are exposed as separate tool names so the model
   * (or caller) can target a specific backend explicitly.
   */
  readonly extraWebSearchers?: readonly ExtraWebSearcher[];
}
