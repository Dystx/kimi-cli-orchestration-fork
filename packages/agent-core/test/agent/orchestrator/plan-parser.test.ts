import { describe, it, expect } from 'vitest';
import { parsePlanMarkdown } from '#/agent/orchestrator/plan-parser';

describe('parsePlanMarkdown', () => {
  it('creates todos from headings and ignores the top-level title', () => {
    const md = `# Plan
## Research
## Implement
## Test
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Research', status: 'pending' },
      { title: 'Implement', status: 'pending' },
      { title: 'Test', status: 'pending' },
    ]);
  });

  it('creates todos from checkbox items and marks a heading done when its section has items', () => {
    const md = `# Plan
## Research
- [x] done item
- [ ] pending item
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Research', status: 'done' },
      { title: 'done item', status: 'done' },
      { title: 'pending item', status: 'pending' },
    ]);
  });

  it('returns an empty array for empty content', () => {
    expect(parsePlanMarkdown('')).toEqual([]);
  });

  it('handles multiple sections with mixed checkbox states', () => {
    const md = `# Plan
## Section A
## Section B
- [ ] only pending
## Section C
- [X] all done
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Section A', status: 'pending' },
      { title: 'Section B', status: 'done' },
      { title: 'only pending', status: 'pending' },
      { title: 'Section C', status: 'done' },
      { title: 'all done', status: 'done' },
    ]);
  });

  it('treats standalone checkbox items before any heading as todos', () => {
    const md = `- [x] standalone done
- [ ] standalone pending
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'standalone done', status: 'done' },
      { title: 'standalone pending', status: 'pending' },
    ]);
  });

  it('ignores blank lines and plain list items without checkboxes', () => {
    const md = `# Plan

## Research
- plain bullet
- [ ] task
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Research', status: 'done' },
      { title: 'task', status: 'pending' },
    ]);
  });
});
