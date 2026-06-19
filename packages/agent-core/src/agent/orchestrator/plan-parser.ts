import type { TodoItem } from '#/tools/builtin/state/todo-list';

/**
 * Parse a plan markdown document into a flat list of {@link TodoItem}s.
 *
 * Rules:
 * - The first `#` heading is treated as the plan title and is not emitted.
 * - `##`–`######` headings become todos. Their status is `done` when every
 *   checkbox item in the section is checked, `in_progress` when the section has
 *   at least one unchecked checkbox, and `pending` when there are no items.
 * - `- [x]` / `- [X]` items become `done` todos.
 * - `- [ ]` items become `pending` todos.
 */
export function parsePlanMarkdown(content: string): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = content.split(/\r?\n/);

  let currentHeading: string | null = null;
  let currentSectionHasItems = false;
  let currentSectionHasUnchecked = false;
  let currentSectionItems: TodoItem[] = [];

  const flushHeading = (): void => {
    if (currentHeading !== null && currentHeading.length > 0) {
      let status: TodoItem['status'] = 'pending';
      if (currentSectionHasItems) {
        status = currentSectionHasUnchecked ? 'in_progress' : 'done';
      }
      todos.push({
        title: currentHeading,
        status,
      });
    }
    todos.push(...currentSectionItems);
    currentHeading = null;
    currentSectionHasItems = false;
    currentSectionHasUnchecked = false;
    currentSectionItems = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();

      flushHeading();

      if (level === 1) {
        // Top-level heading is the plan title; do not treat as a todo.
        continue;
      }

      currentHeading = title;
      currentSectionHasItems = false;
      currentSectionHasUnchecked = false;
      currentSectionItems = [];
      continue;
    }

    const checkboxMatch = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (checkboxMatch) {
      const title = checkboxMatch[2]!.trim();
      const checked = checkboxMatch[1]!.toLowerCase() === 'x';
      const status = checked ? 'done' : 'pending';

      if (title.length > 0) {
        currentSectionItems.push({ title, status });
        currentSectionHasItems = true;
        if (!checked) {
          currentSectionHasUnchecked = true;
        }
      }

      continue;
    }
  }

  flushHeading();
  return todos;
}
