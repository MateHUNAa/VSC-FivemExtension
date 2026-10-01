/**
 * Returns `text` with every Lua comment (`-- ...`, `--[[ ... ]]`, `--[==[ ... ]==]`) replaced by
 * spaces, keeping newlines and string literals intact, so offsets and line numbers still line up
 * with the original text. Regex scanners run over the masked text so commented-out code (or a
 * `LS:RegisterModule(...)` quoted in a comment) is never picked up.
 */
export function maskComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  /** Length of a long-bracket opener (`[[`, `[=[`, ...) at `pos`, with its level, or undefined. */
  const longBracketAt = (pos: number): { level: number; length: number } | undefined => {
    if (text[pos] !== '[') return undefined;
    let k = pos + 1;
    while (text[k] === '=') k++;
    return text[k] === '[' ? { level: k - pos - 1, length: k - pos + 1 } : undefined;
  };

  const longBracketEnd = (from: number, level: number): number => {
    const close = `]${'='.repeat(level)}]`;
    const idx = text.indexOf(close, from);
    return idx === -1 ? n : idx + close.length;
  };

  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const long = longBracketAt(i + 2);
      if (long) {
        const end = longBracketEnd(i + 2 + long.length, long.level);
        blank(i, end);
        i = end;
      } else {
        let end = text.indexOf('\n', i);
        if (end === -1) end = n;
        blank(i, end);
        i = end;
      }
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '[') {
      const long = longBracketAt(i);
      i = long ? longBracketEnd(i + long.length, long.level) : i + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

export function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Type declarations that belong to a neighbouring type, not to the function below them. */
const FOREIGN_ANNOTATION_RE = /^---\s*@(class|field|alias|enum|type|meta|diagnostic)\b/;

/** The contiguous `---` annotation/doc lines directly above `line` (0-based), trimmed, in order. */
export function docBlockAbove(lines: string[], line: number): string[] {
  const doc: string[] = [];
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('---')) break;
    if (!FOREIGN_ANNOTATION_RE.test(trimmed)) doc.unshift(trimmed);
  }
  return doc;
}

export function splitParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}
