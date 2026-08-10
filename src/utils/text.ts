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
