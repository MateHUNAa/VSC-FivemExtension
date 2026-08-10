import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE, DiagnosticCode } from './diagnostics';

// TriggerServerEvent/TriggerClientEvent (and their Latent variants) are the single most common
// wrong-side typo in FiveM code - a swap fix is unambiguous and always correct.
const TRIGGER_SWAP: Record<string, string> = {
  TriggerServerEvent: 'TriggerClientEvent',
  TriggerClientEvent: 'TriggerServerEvent',
  TriggerLatentServerEvent: 'TriggerLatentClientEvent',
  TriggerLatentClientEvent: 'TriggerLatentServerEvent',
};

/** Quick fixes for diagnostics raised by NativeContextDiagnostics: swap a one-sided
 * Trigger*Event call for its correct counterpart, or suppress the warning on that one line. */
export class NativeQuickFixProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;

      if (diagnostic.code === DiagnosticCode.WrongSideRuntimeFunction) {
        const name = document.getText(diagnostic.range);
        const swap = TRIGGER_SWAP[name];
        if (swap) {
          const fix = new vscode.CodeAction(`Change to '${swap}'`, vscode.CodeActionKind.QuickFix);
          fix.diagnostics = [diagnostic];
          fix.isPreferred = true;
          fix.edit = new vscode.WorkspaceEdit();
          fix.edit.replace(document.uri, diagnostic.range, swap);
          actions.push(fix);
        }
      }

      const line = document.lineAt(diagnostic.range.start.line);
      if (!/--\s*perfectfivem-ignore\b/i.test(line.text)) {
        const ignore = new vscode.CodeAction('Ignore this warning on this line', vscode.CodeActionKind.QuickFix);
        ignore.diagnostics = [diagnostic];
        ignore.edit = new vscode.WorkspaceEdit();
        ignore.edit.insert(document.uri, line.range.end, '  -- perfectfivem-ignore');
        actions.push(ignore);
      }
    }

    return actions;
  }
}
