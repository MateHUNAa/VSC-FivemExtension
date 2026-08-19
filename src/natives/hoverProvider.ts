import * as vscode from 'vscode';
import { buildNativeMarkdown, NativesDatabase } from './nativesDatabase';
import { isMemberAccess } from '../utils/text';

export class NativeHoverProvider implements vscode.HoverProvider {
  constructor(private readonly db: NativesDatabase) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.db.isLoaded) return undefined;
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) return undefined;
    if (isMemberAccess(document.lineAt(range.start.line).text, range.start.character)) return undefined;

    const word = document.getText(range);
    const entries = this.db.getByLuaName(word);
    if (!entries.length) return undefined;

    const contents = entries.map((n) => buildNativeMarkdown(n));
    return new vscode.Hover(contents, range);
  }
}
