import * as vscode from 'vscode';
import { ExportsIndexer } from './exportsIndexer';
import { detectExportsAccess, isInsideEventCallArgument } from './importParser';

/**
 * Completion after `exports['resource']:` or `exports.resource.` / `exports.resource:`,
 * sourced from ExportsIndexer's scan of that resource's `exports(...)` declarations.
 * Covers both bracket and dot access styles required by the spec.
 */
export class ExportsCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly exportsIndex: ExportsIndexer) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const ctx = detectExportsAccess(linePrefix);
    if (!ctx) return undefined;

    const entries = this.exportsIndex.getExports(ctx.resourceName);
    return entries.map((e) => {
      const item = new vscode.CompletionItem(e.name, vscode.CompletionItemKind.Method);
      item.detail = `${ctx.resourceName} export`;
      item.documentation = new vscode.MarkdownString(
        `\`\`\`lua\n${e.name}(${e.params.join(', ')})\n\`\`\`\n\nDefined in ${vscode.workspace.asRelativePath(e.fileUri)}:${e.line + 1}`,
      );
      item.insertText = new vscode.SnippetString(`${e.name}(${e.params.map((p, i) => `\${${i + 1}:${p}}`).join(', ')})`);
      return item;
    });
  }
}

/** Completion for event-name string literals inside TriggerEvent/RegisterNetEvent/AddEventHandler calls. */
export class EventNameCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly exportsIndex: ExportsIndexer) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    if (!isInsideEventCallArgument(linePrefix)) return undefined;

    return this.exportsIndex.getEventNames().map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Event);
      item.detail = 'FiveM event';
      return item;
    });
  }
}
