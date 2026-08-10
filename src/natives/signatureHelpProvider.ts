import * as vscode from 'vscode';
import { NativesDatabase } from './nativesDatabase';

/** Walks backward from the cursor to find the enclosing `Name(...)` call and active parameter index. */
function findEnclosingCall(textBeforeCursor: string): { name: string; activeParam: number } | undefined {
  let depth = 0;
  let commaCount = 0;
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const c = textBeforeCursor[i];
    if (c === ')') {
      depth++;
    } else if (c === '(') {
      if (depth === 0) {
        const before = textBeforeCursor.slice(0, i);
        const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
        return m ? { name: m[1], activeParam: commaCount } : undefined;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      commaCount++;
    }
  }
  return undefined;
}

export class NativeSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly db: NativesDatabase) {}

  provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
    if (!this.db.isLoaded) return undefined;

    const startLine = Math.max(0, position.line - 20);
    const text = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
    const call = findEnclosingCall(text);
    if (!call) return undefined;

    const entries = this.db.getByLuaName(call.name);
    if (!entries.length) return undefined;

    const help = new vscode.SignatureHelp();
    help.activeSignature = 0;
    help.activeParameter = call.activeParam;
    help.signatures = entries.map((n) => {
      const paramsSig = n.params.map((p) => `${p.name}: ${p.type}`);
      const info = new vscode.SignatureInformation(
        `[${n.apiset}] ${n.luaName}(${paramsSig.join(', ')})`,
        n.description ? new vscode.MarkdownString(n.description) : undefined,
      );
      info.parameters = n.params.map((p) => new vscode.ParameterInformation(`${p.name}: ${p.type}`));
      return info;
    });
    return help;
  }
}
