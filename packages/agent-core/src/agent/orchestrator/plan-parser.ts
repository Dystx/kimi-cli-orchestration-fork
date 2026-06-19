import type { TodoItem } from '#/tools/builtin/state/todo-list';

/**
 * Parse a plan markdown document into a flat list of {@link TodoItem}s.
 *
 * Rules:
 * - The first `#` heading is treated as the plan title and is not emitted.
 * - `##`–`######` headings become todos. Their status is `done` when the
 *   section contains at least one checkbox item; otherwise `pending`.
 * - `- [x]` / `- [X]` items become `done` todos.
 * - `- [ ]` items become `pending` todos.
 */
export function parsePlanMarkdown(content: string): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = content.split(/\r?\n/);

  let currentHeading: string | null = null;
  let currentSectionHasItems = false;
  let currentSectionItems: TodoItem[] = [];

  const flushHeading = (): void => {
    if (currentHeading !== null && currentHeading.length > 0) {
      todos.push({
        title: currentHeading,
        status: currentSectionHasItems ? 'done' : 'pending',
      });
    }
    todos.push(...currentSectionItems);
    currentHeading = null;
    currentSectionHasItems = false;
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
      currentSectionItems = [];
      continue;
    }

    const checkboxMatch = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (checkboxMatch) {
      const title = checkboxMatch[2]!.trim();
      const status = checkboxMatch[1]!.toLowerCase() === 'x' ? 'done' : 'pending';

      if (title.length > 0) {
        currentSectionItems.push({ title, status });
        currentSectionHasItems = true;
      }

      continue;
    }
  }

  flushHeading();
  return todos;
}
