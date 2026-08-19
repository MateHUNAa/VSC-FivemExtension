import * as vscode from 'vscode';

/** Converts a raw string offset (as produced by a regex match over `fs.readFile`d text) into a
 * `vscode.Position`, for code that scans file bytes directly instead of an open `TextDocument`. */
export function offsetToPosition(text: string, offset: number): vscode.Position {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return new vscode.Position(line, offset - lastNewline - 1);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether the identifier starting at `nameStart` in `text` is accessed off a table
 * (`Table.Name` / `Table:Name`) rather than called as a bare global. FiveM natives are only ever
 * invoked as bare globals, so callers use this to avoid mistaking a same-named table method
 * (e.g. `AdminFunction.GetPlayerGroup(...)`) for the native of the same name. */
export function isMemberAccess(text: string, nameStart: number): boolean {
  let i = nameStart - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  return i >= 0 && (text[i] === '.' || text[i] === ':');
}
