import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { ScriptContext } from '../core/types';
import { buildNativeMarkdown, isAllowedInContext, NativeEntry, NativesDatabase } from './nativesDatabase';

/**
 * Context-scoped completion for FiveM natives. The active file's script context (client /
 * server / shared) comes from ContextIndex; natives outside that context are hidden entirely
 * for client/server files, and clearly badged for shared files (see isAllowedInContext).
 */
export class NativeCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly db: NativesDatabase, private readonly index: ContextIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (!this.db.isLoaded) return undefined;

    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    const prefix = range ? document.getText(range) : '';
    if (prefix.length < 2) return undefined;

    const fileContext = this.index.getFileContext(document.uri)?.context ?? 'shared';
    const candidates = this.db.queryByPrefix(prefix).filter((n) => isAllowedInContext(n.apiset, fileContext));

    return candidates.map((n) => this.toCompletionItem(n, fileContext));
  }

  private toCompletionItem(n: NativeEntry, fileContext: ScriptContext): vscode.CompletionItem {
    const item = new vscode.CompletionItem(n.luaName, vscode.CompletionItemKind.Function);
    const paramsSig = n.params.map((p) => `${p.name}: ${p.type}`).join(', ');
    item.detail = `[${n.apiset}] ${n.results} ${n.luaName}(${paramsSig})`;
    item.documentation = buildNativeMarkdown(n);
    item.insertText = new vscode.SnippetString(
      `${n.luaName}(${n.params.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ')})`,
    );
    // In shared files, surface natives valid on both sides before single-side ones.
    const priority = fileContext === 'shared' && n.apiset !== 'shared' ? '1' : '0';
    item.sortText = `${priority}${n.luaName}`;
    return item;
  }
}
