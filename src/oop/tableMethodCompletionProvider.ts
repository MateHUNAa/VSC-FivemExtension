import * as vscode from 'vscode';
import { ResourceScanner } from '../core/resourceScanner';
import { TableMethodIndexer } from './tableMethodIndexer';

const ACCESS_RE = /([A-Za-z_]\w*)\s*([:.])\s*$/;

/** Completion after `Table:` / `Table.`, sourced from TableMethodIndexer's scan of the owning resource. */
export class TableMethodCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly indexer: TableMethodIndexer, private readonly scanner: ResourceScanner) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const match = ACCESS_RE.exec(linePrefix);
    if (!match) return undefined;
    const [, tableName] = match;

    const resource = this.scanner.getResourceForFile(document.uri.fsPath);
    if (!resource) return undefined;

    const methods = this.indexer.getMethods(resource, tableName);
    if (!methods.length) return undefined;

    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const method of methods) {
      const dedupeKey = `${method.methodName}(${method.params.join(',')})`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const item = new vscode.CompletionItem(method.methodName, vscode.CompletionItemKind.Method);
      item.detail = `${tableName}${method.style}${method.methodName}(${method.params.join(', ')})`;
      item.documentation = new vscode.MarkdownString(
        `Defined in ${vscode.workspace.asRelativePath(method.fileUri)}:${method.line + 1}`,
      );
      item.insertText = new vscode.SnippetString(
        `${method.methodName}(${method.params.map((p, i) => `\${${i + 1}:${p}}`).join(', ')})`,
      );
      items.push(item);
    }
    return items;
  }
}
