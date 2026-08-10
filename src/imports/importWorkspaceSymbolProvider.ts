import * as vscode from 'vscode';
import { ExportsIndexer } from './exportsIndexer';

/** Feeds "Go to Symbol in Workspace…" (Ctrl+T) from every indexed `exports(...)` declaration and
 * `RegisterNetEvent`/`AddEventHandler` registration, so an export/event can be found without
 * knowing which resource or file declares it. */
export class ImportsWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly exportsIndex: ExportsIndexer) {}

  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    const needle = query.toLowerCase();
    const results: vscode.SymbolInformation[] = [];

    for (const e of this.exportsIndex.getAllExports()) {
      if (needle && !e.name.toLowerCase().includes(needle)) continue;
      results.push(
        new vscode.SymbolInformation(
          e.name,
          vscode.SymbolKind.Method,
          e.resourceName,
          new vscode.Location(e.fileUri, new vscode.Position(e.line, 0)),
        ),
      );
    }

    for (const e of this.exportsIndex.getAllEvents()) {
      // Only handler registrations count as "definitions" here - trigger call sites would add a
      // symbol-list entry per call, which is noise (they're reachable via go-to-definition instead).
      if (e.kind !== 'register') continue;
      if (needle && !e.name.toLowerCase().includes(needle)) continue;
      results.push(
        new vscode.SymbolInformation(
          e.name,
          vscode.SymbolKind.Event,
          e.resourceName,
          new vscode.Location(e.fileUri, new vscode.Position(e.line, 0)),
        ),
      );
    }

    return results;
  }
}
