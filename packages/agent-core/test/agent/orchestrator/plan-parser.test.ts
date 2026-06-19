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

  it('creates todos from checkbox items and marks a heading done when all items are checked', () => {
    const md = `# Plan
## Research
- [x] done item
- [X] also done
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Research', status: 'done' },
      { title: 'done item', status: 'done' },
      { title: 'also done', status: 'done' },
    ]);
  });

  it('marks a heading in_progress when its section has unchecked items', () => {
    const md = `# Plan
## Research
- [x] done item
- [ ] pending item
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Research', status: 'in_progress' },
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
      { title: 'Section B', status: 'in_progress' },
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
      { title: 'Research', status: 'in_progress' },
      { title: 'task', status: 'pending' },
    ]);
  });

  it('marks heading done when all checkboxes in the section are checked', () => {
    const md = `# Plan
## Section
- [x] item one
- [x] item two
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Section', status: 'done' },
      { title: 'item one', status: 'done' },
      { title: 'item two', status: 'done' },
    ]);
  });

  it('marks heading in_progress when checkboxes are mixed', () => {
    const md = `# Plan
## Section
- [x] item one
- [ ] item two
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Section', status: 'in_progress' },
      { title: 'item one', status: 'done' },
      { title: 'item two', status: 'pending' },
    ]);
  });

  it('marks heading in_progress when all checkboxes are pending', () => {
    const md = `# Plan
## Section
- [ ] item one
- [ ] item two
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Section', status: 'in_progress' },
      { title: 'item one', status: 'pending' },
      { title: 'item two', status: 'pending' },
    ]);
  });

  it('marks heading pending when the section has no checkbox items', () => {
    const md = `# Plan
## Section
- plain bullet
plain text
`;
    expect(parsePlanMarkdown(md)).toEqual([
      { title: 'Section', status: 'pending' },
    ]);
  });
});
