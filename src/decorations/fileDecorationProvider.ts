import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { ScriptContext } from '../core/types';

const BADGES: Record<ScriptContext, { badge: string; tooltip: string; color: string }> = {
  client: { badge: 'C', tooltip: 'FiveM client script', color: 'charts.blue' },
  server: { badge: 'S', tooltip: 'FiveM server script', color: 'charts.red' },
  shared: { badge: 'SH', tooltip: 'FiveM shared script', color: 'charts.purple' },
};

/**
 * Badges Lua files in the Explorer with their client/server/shared context. Reads only from
 * ContextIndex's precomputed map - never touches the filesystem or fxmanifest at display time.
 */
export class ContextFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly index: ContextIndex) {
    this.disposable = index.onDidChangeContext((uris) => this._onDidChangeFileDecorations.fire(uris));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.fsPath.toLowerCase().endsWith('.lua')) return undefined;
    const entry = this.index.getFileContext(uri);
    if (!entry) return undefined; // fallback: no decoration for Lua files outside any resource
    const spec = BADGES[entry.context];
    return {
      badge: spec.badge,
      tooltip: `${spec.tooltip} (${entry.resource.name})`,
      color: new vscode.ThemeColor(spec.color),
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
