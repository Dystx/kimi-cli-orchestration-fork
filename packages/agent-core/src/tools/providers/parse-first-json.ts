/**
 * Shared helpers for providers that spawn `mavis mcp call` and parse the
 * JSON response.
 */

/**
 * Parses the first top-level JSON value in `text`. The matrix CLI sometimes
 * appends a `[matrix-mcp-cli:hint]` block or other trailing content after
 * the JSON, so a plain `JSON.parse` would reject the response and surface a
 * confusing "non-JSON output" error to the model.
 *
 * Returns `undefined` if no JSON value is found at the start of `text`.
 */
export function parseFirstJson<T = unknown>(text: string): T | undefined {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return undefined;

  // Fast path: the entire text is valid JSON.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Fall through to the bracket-walk.
  }

  // Walk the string character-by-character, tracking JSON string boundaries
  // and bracket nesting. Stop at the matching closing brace of the first
  // top-level `{` so trailing hint text is discarded.
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined;

  const openChar = trimmed[0]!;
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(0, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
