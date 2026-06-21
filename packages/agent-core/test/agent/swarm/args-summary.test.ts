import { describe, it, expect } from 'vitest';
import { summarizeArgs } from '../../../src/agent/swarm/args-summary';

describe('summarizeArgs', () => {
  it('extracts file_path for read_file-like tools', () => {
    expect(summarizeArgs('read_file', { file_path: '/Users/cheng/kimi-code/README.md' })).toBe('kimi-code/README.md');
  });

  it('extracts path for shell-like tools', () => {
    expect(summarizeArgs('shell', { path: '/Users/cheng/kimi-code/scripts/run.sh' })).toBe('kimi-code/scripts/run.sh');
  });

  it('truncates long commands', () => {
    const cmd = 'npm test --watch --coverage -- --runInBand --testPathPattern=integration';
    const out = summarizeArgs('shell', { command: cmd }) ?? '';
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns command verbatim when short enough', () => {
    expect(summarizeArgs('shell', { command: 'ls -la' })).toBe('ls -la');
  });

  it('extracts url', () => {
    expect(summarizeArgs('web_fetch', { url: 'https://example.com/foo' })).toBe('https://example.com/foo');
  });

  it('falls back to the first string field', () => {
    expect(summarizeArgs('custom_tool', { foo: 'bar', baz: 42 })).toBe('bar');
  });

  it('returns undefined for non-object args', () => {
    expect(summarizeArgs('foo', null)).toBeUndefined();
    expect(summarizeArgs('foo', 'string')).toBeUndefined();
    expect(summarizeArgs('foo', 42)).toBeUndefined();
  });

  it('returns undefined for empty args', () => {
    expect(summarizeArgs('foo', {})).toBeUndefined();
  });

  it('shortens a deeply-nested path to last two segments', () => {
    expect(summarizeArgs('read_file', { file_path: '/a/b/c/d/e.md' })).toBe('d/e.md');
  });
});