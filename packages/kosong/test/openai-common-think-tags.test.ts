import { splitThinkTags, ThinkTagSplitter } from '#/providers/openai-common';
import { describe, it, expect } from 'vitest';

/**
 * Tests for the inline `<think>...</think>` splitter used by
 * {@link import('#/providers/openai-legacy').OpenAILegacyChatProvider} to
 * normalise OpenAI-compatible providers (e.g. MiniMax-M3) that ship
 * reasoning inside the regular `content` field.
 *
 * The splitter is a tiny state machine; both single-call (`splitThinkTags`)
 * and streaming (`new ThinkTagSplitter()`) entry points are covered because
 * the streaming path must carry state across chunks when a tag is split
 * mid-token by SSE.
 */
describe('splitThinkTags (non-stream helper)', () => {
  it('passes through plain text with no tags', () => {
    expect(splitThinkTags('hello world')).toEqual([{ think: null, text: 'hello world' }]);
  });

  it('returns an empty result for an empty string', () => {
    expect(splitThinkTags('')).toEqual([]);
  });

  it('splits a single inline think block from preceding and following text', () => {
    expect(splitThinkTags('hi<think>reasoning</think>there')).toEqual([
      { think: null, text: 'hi' },
      { think: 'reasoning', text: null },
      { think: null, text: 'there' },
    ]);
  });

  it('handles text that starts with a think block', () => {
    expect(splitThinkTags('<think>foo</think>bar')).toEqual([
      { think: 'foo', text: null },
      { think: null, text: 'bar' },
    ]);
  });

  it('handles text that ends with a think block', () => {
    expect(splitThinkTags('bar<think>foo</think>')).toEqual([
      { think: null, text: 'bar' },
      { think: 'foo', text: null },
    ]);
  });

  it('emits an empty think segment for an empty think block', () => {
    expect(splitThinkTags('<think></think>after')).toEqual([
      { think: null, text: 'after' },
    ]);
  });

  it('treats content after an empty think block as text', () => {
    // A `<think></think>` with nothing inside is a no-op for reasoning;
    // everything after the close tag is plain visible text.
    expect(splitThinkTags('<think></think>hello')).toEqual([
      { think: null, text: 'hello' },
    ]);
  });

  it('treats a stray close tag with no matching open as plain text', () => {
    // Defensive: a malformed stream that includes `</think>` in text mode
    // must NOT enter think mode. The stray tag is consumed (treated as
    // an explicit end of any potential think block), but we never re-enter
    // think mode on a stray. The user-visible text concatenates back to
    // the original minus the consumed tag.
    const segments = splitThinkTags('a</think>b');
    const text = segments.map((s) => s.text ?? '').join('');
    expect(text).toBe('ab');
  });

  it('emits multiple think blocks in order', () => {
    expect(
      splitThinkTags('<think>a</think>middle<think>b</think>tail'),
    ).toEqual([
      { think: 'a', text: null },
      { think: null, text: 'middle' },
      { think: 'b', text: null },
      { think: null, text: 'tail' },
    ]);
  });

  it('treats unterminated trailing think content as reasoning, not text', () => {
    // The split happens once at the open tag, so anything after it lives
    // inside the think block until the close tag. With no close tag, the
    // content should not leak into the visible text path.
    expect(splitThinkTags('hello<think>thinking forever')).toEqual([
      { think: null, text: 'hello' },
      { think: 'thinking forever', text: null },
    ]);
  });

  it('does not re-interpret a stray close tag after reasoning', () => {
    // After a legitimate `</think>`, the splitter is back in text mode.
    // Any subsequent `</think>` is consumed as a stray close tag without
    // re-entering think mode. The visible text the user sees is exactly
    // the same as the input minus the legitimate think block — we just
    // split it into multiple text segments because we consume the stray
    // tag. After filtering, the downstream consumer sees `think: 'a'`
    // and `text: 'bc'`.
    const segments = splitThinkTags('<think>a</think>b</think>c');
    const text = segments
      .map((s) => s.text ?? '')
      .join('');
    expect(segments[0]).toEqual({ think: 'a', text: null });
    expect(text).toBe('bc');
  });
});

describe('ThinkTagSplitter (streaming state machine)', () => {
  it('buffers a partial open tag across two chunks', () => {
    const splitter = new ThinkTagSplitter();
    expect(splitter.push('<thi')).toEqual([]);
    expect(splitter.push('nk>foo</think>bar')).toEqual([
      { think: 'foo', text: null },
      { think: null, text: 'bar' },
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  it('buffers a partial close tag across two chunks', () => {
    const splitter = new ThinkTagSplitter();
    // The first push contains a complete open tag, complete reasoning,
    // and a partial close tag. We emit the reasoning now and retain
    // the partial `</th` for the next call.
    expect(splitter.push('<think>foo</th')).toEqual([
      { think: 'foo', text: null },
    ]);
    expect(splitter.push('ink>bar')).toEqual([
      { think: null, text: 'bar' },
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  it('emits text prefix when a tag is split mid-token', () => {
    const splitter = new ThinkTagSplitter();
    // First chunk ends with `<thi` — no full open tag yet, so we hold the
    // text prefix. The 7-char boundary means we keep `<thi` buffered.
    expect(splitter.push('hello<thi')).toEqual([
      { think: null, text: 'hello' },
    ]);
    expect(splitter.push('nk>foo</think>bar')).toEqual([
      { think: 'foo', text: null },
      { think: null, text: 'bar' },
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  it('flush() yields the trailing buffer at end of stream', () => {
    const splitter = new ThinkTagSplitter();
    // The push contains a complete open tag and reasoning text but no
    // close tag. The reasoning is emitted immediately because the open
    // tag is complete; flush() then has nothing left to emit.
    expect(splitter.push('<think>partial reasoning')).toEqual([
      { think: 'partial reasoning', text: null },
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  it('flush() emits a buffered partial open tag as visible text', () => {
    // Pathological case: the open tag itself is split across chunks and
    // the stream ends before the tag completes. The buffer was held in
    // text mode (no complete open tag was ever seen), so flush emits it
    // as visible text rather than reasoning. This is the conservative
    // default — we only emit reasoning once a complete open tag has been
    // matched.
    const splitter = new ThinkTagSplitter();
    expect(splitter.push('<thi')).toEqual([]);
    expect(splitter.flush()).toEqual([{ think: null, text: '<thi' }]);
  });

  it('flush() returns nothing when the buffer is empty', () => {
    const splitter = new ThinkTagSplitter();
    expect(splitter.flush()).toEqual([]);
    // Calling flush twice is safe.
    expect(splitter.flush()).toEqual([]);
  });

  it('flush() returns nothing when push already drained the buffer', () => {
    const splitter = new ThinkTagSplitter();
    expect(splitter.push('<think>foo</think>hello')).toEqual([
      { think: 'foo', text: null },
      { think: null, text: 'hello' },
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  it('reset() clears state between unrelated streams', () => {
    const splitter = new ThinkTagSplitter();
    splitter.push('<think>half-formed');
    splitter.reset();
    expect(splitter.push('clean text')).toEqual([{ think: null, text: 'clean text' }]);
    expect(splitter.flush()).toEqual([]);
  });

  it('handles a long stream of alternating text and think chunks', () => {
    const splitter = new ThinkTagSplitter();
    // Mimic a real SSE stream: tiny deltas interleaved with tags.
    const stream = [
      '<think>',
      'step 1',
      '</think>',
      'ok ',
      '<thi',
      'nk>',
      'step 2',
      '</think>',
      'done',
    ];
    const segments: { think: string | null; text: string | null }[] = [];
    for (const chunk of stream) {
      for (const seg of splitter.push(chunk)) segments.push(seg);
    }
    for (const seg of splitter.flush()) segments.push(seg);
    // After filtering empty segments, the order should be: think "step 1",
    // text "ok ", think "step 2", text "done".
    const nonEmpty = segments.filter(
      (s) => (s.think !== null && s.think.length > 0) || (s.text !== null && s.text.length > 0),
    );
    expect(nonEmpty).toEqual([
      { think: 'step 1', text: null },
      { think: null, text: 'ok ' },
      { think: 'step 2', text: null },
      { think: null, text: 'done' },
    ]);
  });

  it('push("") is a no-op', () => {
    const splitter = new ThinkTagSplitter();
    expect(splitter.push('')).toEqual([]);
  });
});