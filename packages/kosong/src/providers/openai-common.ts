import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '#/errors';
import { extractText } from '#/message';
import type { ContentPart, Message } from '#/message';
import type { FinishReason, ThinkingEffort } from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIError as OpenAIAPIError,
  OpenAIError,
} from 'openai';
export interface OpenAIContentPart {
  type: string;
  text?: string | undefined;
  image_url?: { url: string; id?: string | null } | undefined;
  audio_url?: { url: string; id?: string | null } | undefined;
  video_url?: { url: string; id?: string | null } | undefined;
}

/**
 * Convert a kosong `ContentPart` to OpenAI-compatible content part.
 * Returns `null` for think parts (handled separately as reasoning_content).
 */
export function convertContentPart(part: ContentPart): OpenAIContentPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      // Think parts are handled separately as reasoning_content — skip them here.
      return null;
    case 'image_url':
      return {
        type: 'image_url',
        image_url:
          part.imageUrl.id === undefined
            ? { url: part.imageUrl.url }
            : { url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audio_url:
          part.audioUrl.id === undefined
            ? { url: part.audioUrl.url }
            : { url: part.audioUrl.url, id: part.audioUrl.id },
      };
    case 'video_url':
      return {
        type: 'video_url',
        video_url:
          part.videoUrl.id === undefined
            ? { url: part.videoUrl.url }
            : { url: part.videoUrl.url, id: part.videoUrl.id },
      };
    default:
      throw new Error(`Unknown content part type: ${(part as ContentPart).type}`);
  }
}
export interface OpenAIToolParam {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Convert a kosong `Tool` to OpenAI tool format.
 */
export function toolToOpenAI(tool: Tool): OpenAIToolParam {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
// `terminated` is the undici signature for an SSE/HTTP body stream that is
// dropped mid-flight (common with Node's native fetch on long reasoning
// streams). It surfaces as a raw `TypeError: terminated`, so it must be
// recognized here as a transport-layer connection failure.
const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

function classifyBaseApiError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}

/**
 * Convert an OpenAI SDK error (or raw Error) to a kosong `ChatProviderError`.
 */
export function convertOpenAIError(error: unknown): ChatProviderError {
  if (error instanceof ChatProviderError) {
    return error;
  }
  // v6: APIConnectionTimeoutError extends APIConnectionError, check timeout first
  if (error instanceof OpenAITimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof OpenAIConnectionError) {
    return new APIConnectionError(error.message);
  }
  // APIError with a status code => status error
  if (error instanceof OpenAIAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(error.status, error.message, reqId);
  }
  // Base APIError with no status and no body => transport-layer failure.
  // When the error has a body (e.g. SSE error events from the server),
  // skip the heuristic to avoid misclassifying server-side errors.
  if (
    error instanceof OpenAIAPIError &&
    error.constructor === OpenAIAPIError &&
    error.error === undefined
  ) {
    return classifyBaseApiError(error.message);
  }
  if (error instanceof OpenAIError) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  // Raw, non-SDK errors (e.g. undici's `TypeError: terminated` raised when a
  // streaming response body is dropped mid-flight) never get wrapped by the
  // OpenAI SDK during stream iteration. Route them through the same
  // transport-layer heuristic so genuine connection failures become
  // retryable instead of fatal generic errors.
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}
/** Shape of a function-type tool call (subset used by the guard). */
export interface FunctionToolCallShape {
  type: 'function';
  id: string;
  function: { name: string; arguments: string | null };
}

/**
 * Type guard: narrow a tool call union to the function-type variant.
 * Works with OpenAI SDK's `ChatCompletionMessageToolCall` as well as
 * any object carrying `{ type: string }`.
 */
export function isFunctionToolCall<T extends { type: string }>(
  tc: T,
): tc is T & FunctionToolCallShape {
  return tc.type === 'function';
}
/**
 * Map kosong `ThinkingEffort` to OpenAI `reasoning_effort` string.
 */
export function thinkingEffortToReasoningEffort(effort: ThinkingEffort): string | undefined {
  switch (effort) {
    case 'off':
      return undefined;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default:
      throw new Error(`Unknown thinking effort: ${String(effort)}`);
  }
}

/**
 * Map OpenAI `reasoning_effort` string back to kosong `ThinkingEffort`.
 */
export function reasoningEffortToThinkingEffort(
  reasoning: string | undefined,
): ThinkingEffort | null {
  if (reasoning === undefined || reasoning === null) {
    return null;
  }
  switch (reasoning) {
    case 'low':
    case 'minimal':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    case 'none':
      return 'off';
    default:
      return 'off';
  }
}
/**
 * Extract `TokenUsage` from an OpenAI-compatible usage object.
 */
export function extractUsage(usage: unknown): TokenUsage | null {
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const promptTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0;
  const completionTokens = typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0;

  let cached = 0;
  // Moonshot proprietary: top-level cached_tokens
  if (typeof u['cached_tokens'] === 'number') {
    cached = u['cached_tokens'];
  } else if (
    typeof u['prompt_tokens_details'] === 'object' &&
    u['prompt_tokens_details'] !== null
  ) {
    const details = u['prompt_tokens_details'] as Record<string, unknown>;
    if (typeof details['cached_tokens'] === 'number') {
      cached = details['cached_tokens'];
    }
  }

  return {
    inputOther: promptTokens - cached,
    output: completionTokens,
    inputCacheRead: cached,
    inputCacheCreation: 0,
  };
}
/**
 * Normalize an OpenAI Chat Completions–style `finish_reason` string to the
 * unified {@link FinishReason} enum.
 *
 * Used by both the Kimi and OpenAI Legacy adapters because they share the
 * Chat Completions wire format. Returns `{ finishReason: null,
 * rawFinishReason: null }` when the upstream value is missing or `null` so
 * callers can treat "no signal" uniformly.
 *
 * Mapping:
 * - `'stop'` → `'completed'`
 * - `'tool_calls'` → `'tool_calls'`
 * - `'function_call'` → `'tool_calls'` (legacy alias)
 * - `'length'` → `'truncated'`
 * - `'content_filter'` → `'filtered'`
 * - any other non-null string → `'other'`
 */
export function normalizeOpenAIFinishReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'stop':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'tool_calls':
    case 'function_call':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'length':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'content_filter':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}
/**
 * Strategy for converting tool-role message content.
 *
 * - `'extract_text'`: flatten all content parts into a single text string
 *   (some providers require tool results as plain text).
 * - `null`: convert content parts to the standard OpenAI content-part array.
 */
export type ToolMessageConversion = 'extract_text' | null;

/**
 * Shared wording for tool-result media that cannot live inside the tool
 * message itself and is reattached as a follow-up user message instead.
 */
export const TOOL_RESULT_MEDIA_PROMPT = 'Attached media from tool result:';
export const TOOL_RESULT_MEDIA_PLACEHOLDER = '(see attached media)';

/**
 * Streaming-aware splitter for OpenAI-compatible responses that embed the
 * model's chain-of-thought inline as `<think>...</think>` blocks within the
 * regular `content` field, instead of routing it through a separate
 * `reasoning_content` field.
 *
 * Some MiniMax-style providers serialize reasoning this way; the harness
 * expects reasoning as a discrete {@link StreamedMessagePart} of type
 * `'think'`, so the splitter walks the incoming text, peels `<think>...`
 * segments out, and yields them as `(think, text)` segment pairs. Whichever
 * side is empty in a given segment is returned as `null` so the caller can
 * decide whether to emit a yield.
 *
 * The splitter is stateful across calls so a `<think>` (or `</think>`) tag
 * that is split between two SSE chunks is still recognised. Pass the same
 * instance through the whole stream; call {@link reset} for non-stream use.
 *
 * Behaviour:
 * - `<think>foo</think>bar` → `('foo', null)`, `(null, 'bar')`
 * - `<think>foo` (no close) → flushed at end via {@link flush}; any
 *   unterminated prefix is treated as reasoning rather than leaked as text,
 *   because reasoning is content the user should not see by default.
 * - Text without any tags passes through unchanged on the text side.
 * - Nested or stray tags inside reasoning (e.g. `<think><think>x</think>`)
 *   are not re-interpreted; the first `</think>` closes the outer block.
 */
export class ThinkTagSplitter {
  private buffer = '';
  private inThink = false;

  /** Feed an incoming chunk; return zero or more `(think, text)` segments. */
  push(chunk: string): ThinkTagSegment[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    return this.drain(/*final*/ false);
  }

  /**
   * End-of-stream flush. Returns any remaining buffered content: a closing
   * `</think>` is consumed, the rest of the buffer is yielded according to
   * the current mode. Safe to call multiple times.
   */
  flush(): ThinkTagSegment[] {
    if (this.buffer.length === 0 && !this.inThink) return [];
    const segments = this.drain(/*final*/ true);
    this.reset();
    return segments;
  }

  /** Reset the splitter state (used by tests and by non-stream use). */
  reset(): void {
    this.buffer = '';
    this.inThink = false;
  }

  private drain(final: boolean): ThinkTagSegment[] {
    const segments: ThinkTagSegment[] = [];
    let cursor = 0;

    while (cursor < this.buffer.length) {
      if (this.inThink) {
        const closeIdx = this.buffer.indexOf('</think>', cursor);
        if (closeIdx === -1) {
          // No complete close tag in the buffered view. Emit everything up
          // to a partial-tag-safe suffix, and retain that suffix for the
          // next call (or flush it on the final call).
          const retain = final ? 0 : partialTagSuffixLength(this.buffer, '</think>');
          const emitEnd = this.buffer.length - retain;
          if (emitEnd > cursor) {
            segments.push({ think: this.buffer.slice(cursor, emitEnd), text: null });
            cursor = emitEnd;
          }
          break;
        }
        // Emit reasoning up to the closing tag, then flip mode.
        if (closeIdx > cursor) {
          segments.push({ think: this.buffer.slice(cursor, closeIdx), text: null });
        }
        cursor = closeIdx + '</think>'.length;
        this.inThink = false;
        // Continue scanning — there may be more content (or another tag)
        // after the close.
      } else {
        // Text mode: scan for whichever tag comes first. A stray close tag
        // with no matching open is treated as plain visible text; we
        // never re-enter think mode on it.
        const openIdx = this.buffer.indexOf('<think>', cursor);
        const closeIdx = this.buffer.indexOf('</think>', cursor);
        if (openIdx === -1 && closeIdx === -1) {
          // No complete tag in the buffered view. Emit text up to a
          // partial-tag-safe suffix, and retain that suffix.
          const retainOpen = final ? 0 : partialTagSuffixLength(this.buffer, '<think>');
          const retainClose = final ? 0 : partialTagSuffixLength(this.buffer, '</think>');
          // The two partial suffixes could overlap; the longest one wins
          // because we want to retain enough to recognise either tag.
          const retain = Math.max(retainOpen, retainClose);
          const emitEnd = this.buffer.length - retain;
          if (emitEnd > cursor) {
            segments.push({ think: null, text: this.buffer.slice(cursor, emitEnd) });
          }
          cursor = emitEnd;
          break;
        }
        if (openIdx !== -1 && (closeIdx === -1 || openIdx <= closeIdx)) {
          // Open tag first (or tied with close, which is impossible since
          // they have different lengths but we still guard).
          if (openIdx > cursor) {
            segments.push({ think: null, text: this.buffer.slice(cursor, openIdx) });
          }
          cursor = openIdx + '<think>'.length;
          this.inThink = true;
        } else {
          // Stray close tag — emit as text, do NOT enter think mode.
          if (closeIdx !== undefined && closeIdx > cursor) {
            segments.push({ think: null, text: this.buffer.slice(cursor, closeIdx) });
          }
          cursor = (closeIdx ?? cursor) + '</think>'.length;
        }
      }
    }

    // Compact the consumed prefix out of the buffer.
    this.buffer = cursor < this.buffer.length ? this.buffer.slice(cursor) : '';
    return segments;
  }
}

/** One (think, text) segment from {@link ThinkTagSplitter}. */
export interface ThinkTagSegment {
  /** Reasoning text to emit as a `ThinkPart`. `null` if no reasoning in this segment. */
  think: string | null;
  /** Visible text to emit as a `TextPart`. `null` if no visible text in this segment. */
  text: string | null;
}

/**
 * Convenience: split a complete (non-streaming) content string. Equivalent
 * to constructing a splitter, pushing the whole string, then flushing.
 */
export function splitThinkTags(content: string): ThinkTagSegment[] {
  const splitter = new ThinkTagSplitter();
  const out = splitter.push(content);
  return out.concat(splitter.flush());
}

/**
 * Return the length of the longest proper suffix of `buffer` that is a
 * proper prefix of `tag`. Used by the splitter to retain a potential
 * partial tag across chunk boundaries without losing data.
 *
 * Examples (with `tag = '<think>'`, length 7):
 *   '<think>'           → 0  (it's the full tag — indexOf would have matched)
 *   '<thi'              → 4
 *   'foo<thi'           → 4
 *   'think>'            → 0  (suffix does not start with `<`)
 *
 * For `tag = ''` (length 8):
 *   '</th'              → 3
 *   'foo</th'           → 3
 */
function partialTagSuffixLength(buffer: string, tag: string): number {
  const maxLen = tag.length - 1;
  for (let len = maxLen; len > 0; len--) {
    const suffix = buffer.slice(buffer.length - len);
    if (tag.startsWith(suffix)) return len;
  }
  return 0;
}

/** A content part that is neither plain text nor reasoning. */
export function isMediaPart(part: ContentPart): boolean {
  return part.type !== 'text' && part.type !== 'think';
}

/**
 * Convert tool-role message content according to the chosen strategy.
 */
export function convertToolMessageContent(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  if (conversion === 'extract_text') {
    return extractText(message);
  }
  return message.content
    .map((p) => convertContentPart(p))
    .filter((p): p is OpenAIContentPart => p !== null);
}
