import * as vscode from 'vscode';
import { ExportsIndexer } from './exportsIndexer';

const REGISTER_CALL_RE = /\b(?:RegisterNetEvent|AddEventHandler)\s*\(\s*['"]([^'"]+)['"]/g;
const TRIGGER_CALL_RE =
  /\b(?:TriggerEvent|TriggerServerEvent|TriggerClientEvent|TriggerLatentServerEvent|TriggerLatentClientEvent)\s*\(\s*['"]([^'"]+)['"]/g;

/** Above every `RegisterNetEvent`/`AddEventHandler` line, shows "N triggers" (and the reverse
 * above every `TriggerEvent`-family line: "N handlers"), sourced from ExportsIndexer. Clicking it
 * opens VS Code's built-in references peek list, so every call/handler is one click away without
 * needing to already know to invoke go-to-definition. Lines with zero matches on the opposite
 * side are skipped - a "0" lens here just means the regex-based indexer didn't find one, which
 * isn't worth surfacing as if it were a confirmed fact. */
export class ImportsEventCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly exportsIndex: ExportsIndexer) {
    this.exportsIndex.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];

    REGISTER_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REGISTER_CALL_RE.exec(text))) {
      const triggers = this.exportsIndex.getAllEvents().filter((e) => e.kind === 'trigger' && e.name === m![1]);
      this.pushLens(lenses, document, m.index, m[0].length, triggers, 'trigger');
    }

    TRIGGER_CALL_RE.lastIndex = 0;
    while ((m = TRIGGER_CALL_RE.exec(text))) {
      const handlers = this.exportsIndex.getAllEvents().filter((e) => e.kind === 'register' && e.name === m![1]);
      this.pushLens(lenses, document, m.index, m[0].length, handlers, 'handler');
    }

    return lenses;
  }

  private pushLens(
    lenses: vscode.CodeLens[],
    document: vscode.TextDocument,
    matchIndex: number,
    matchLength: number,
    entries: { fileUri: vscode.Uri; line: number }[],
    label: 'trigger' | 'handler',
  ): void {
    if (!entries.length) return;
    const range = new vscode.Range(document.positionAt(matchIndex), document.positionAt(matchIndex + matchLength));
    const locations = entries.map((e) => new vscode.Location(e.fileUri, new vscode.Position(e.line, 0)));
    const title = `${entries.length} ${label}${entries.length === 1 ? '' : 's'}`;
    lenses.push(
      new vscode.CodeLens(range, {
        title,
        command: 'editor.action.showReferences',
        arguments: [document.uri, range.start, locations],
      }),
    );
  }
}
