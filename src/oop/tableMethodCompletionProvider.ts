import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { ResourceScanner } from '../core/resourceScanner';
import { ResourceRoot } from '../core/types';
import { ExportsIndexer } from '../imports/exportsIndexer';
import { TableMethodEntry, TableMethodIndexer } from './tableMethodIndexer';

const ACCESS_RE = /([A-Za-z_]\w*)\s*([:.])\s*$/;

/**
 * Completion after `Table:` / `Table.`, sourced from TableMethodIndexer's scan of the owning
 * resource. If nothing matches locally, also checks resources this one imports via
 * `@resource/path` entries in shared_scripts (e.g. a core framework's `init.lua`) - this is how
 * a proxy global like `ls_core`'s `LS` (declared with `function LS:Method(...)` inside the
 * imported file, not the consuming resource) still gets completions. Once a real method match
 * confirms the table lives in that imported resource, that resource's `exports(...)` are merged
 * in too, since these proxy-global patterns typically forward unknown calls to their own exports.
 */
export class TableMethodCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly indexer: TableMethodIndexer,
    private readonly scanner: ResourceScanner,
    private readonly contextIndex: ContextIndex,
    private readonly exportsIndex: ExportsIndexer,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const match = ACCESS_RE.exec(linePrefix);
    if (!match) return undefined;
    const [, tableName] = match;

    const resource = this.scanner.getResourceForFile(document.uri.fsPath);
    if (!resource) return undefined;

    let methods = this.indexer.getMethods(resource, tableName);
    let exportsSource: ResourceRoot | undefined;

    if (!methods.length) {
      exportsSource = this.findImportedTableSource(resource, tableName);
      if (exportsSource) methods = this.indexer.getMethods(exportsSource, tableName);
    }
    if (!methods.length && !exportsSource) return undefined;

    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const method of methods) {
      if (seen.has(method.methodName)) continue;
      seen.add(method.methodName);
      items.push(this.methodItem(tableName, method));
    }

    if (exportsSource) {
      for (const e of this.exportsIndex.getExports(exportsSource.name)) {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        const item = new vscode.CompletionItem(e.name, vscode.CompletionItemKind.Method);
        item.detail = `${tableName}:${e.name}(${e.params.join(', ')}) — ${exportsSource.name} export`;
        item.documentation = new vscode.MarkdownString(
          `Defined in ${vscode.workspace.asRelativePath(e.fileUri)}:${e.line + 1}`,
        );
        item.insertText = new vscode.SnippetString(`${e.name}(${e.params.map((p, i) => `\${${i + 1}:${p}}`).join(', ')})`);
        items.push(item);
      }

      for (const item of items) item.sortText = `0_${item.label}`;
      for (const folder of await this.listUnseenModuleFolders(exportsSource, seen)) {
        const item = new vscode.CompletionItem(folder, vscode.CompletionItemKind.Folder);
        item.detail = `possible ${exportsSource.name} module (not yet loaded/typed)`;
        item.documentation = new vscode.MarkdownString(
          `A \`modules/${folder}/\` folder exists in **${exportsSource.name}** but isn't statically wired to \`${tableName}\` anywhere ` +
            `(it's loaded dynamically at runtime), so this is a name-only guess - no signature available. ` +
            `Check \`modules/${folder}/\` in that resource to see what it offers.`,
        );
        item.sortText = `1_${folder}`;
        items.push(item);
      }
    }

    return items;
  }

  /** Subfolders of `<resource>/modules/` not already covered by a confirmed method/export match - a name-only discovery aid for lazily-loaded modules with no static declaration anywhere. */
  private async listUnseenModuleFolders(resource: ResourceRoot, seen: Set<string>): Promise<string[]> {
    const seenLower = new Set([...seen].map((s) => s.toLowerCase()));
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(resource.uri, 'modules'));
      return entries
        .filter(([name, type]) => (type & vscode.FileType.Directory) !== 0 && !seenLower.has(name.toLowerCase()))
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  /** Resolves this resource's `@resource/path` manifest imports and returns the first one that actually declares `function <tableName>:...`. */
  private findImportedTableSource(resource: ResourceRoot, tableName: string): ResourceRoot | undefined {
    const manifest = this.contextIndex.getManifest(resource);
    const importedNames = new Set((manifest?.imports ?? []).map((i) => i.resourceName));
    for (const name of importedNames) {
      const importedRoot = this.contextIndex.getResourceByName(name);
      if (!importedRoot) continue;
      if (this.indexer.getMethods(importedRoot, tableName).length) return importedRoot;
    }
    return undefined;
  }

  private methodItem(tableName: string, method: TableMethodEntry): vscode.CompletionItem {
    const item = new vscode.CompletionItem(method.methodName, vscode.CompletionItemKind.Method);
    item.detail = `${tableName}${method.style}${method.methodName}(${method.params.join(', ')})`;
    item.documentation = new vscode.MarkdownString(
      `Defined in ${vscode.workspace.asRelativePath(method.fileUri)}:${method.line + 1}`,
    );
    item.insertText = new vscode.SnippetString(
      `${method.methodName}(${method.params.map((p, i) => `\${${i + 1}:${p}}`).join(', ')})`,
    );
    return item;
  }
}
