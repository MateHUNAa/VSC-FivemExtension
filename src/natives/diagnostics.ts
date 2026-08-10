import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { isAllowedInContext, NativesDatabase } from './nativesDatabase';

// A small built-in starting point; extend via perfectFivem.natives.deprecatedOverrides.
const BUILTIN_DEPRECATED = new Set<string>(['SetPedAmmo', 'GetPedAmmoInClip', 'GetPlayerInvincible']);

const CALL_RE = /\b([A-Z][A-Za-z0-9]*)\s*\(/g;

/**
 * Flags natives used on the wrong side (a server-only native called in a client script, or
 * vice versa) and a small curated set of deprecated natives. Deliberately does NOT flag
 * unknown identifiers as "undefined natives" - without full static resolution of locals/
 * requires that would produce far too many false positives on ordinary user functions.
 */
export class NativeContextDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('perfect-fivem');

  constructor(private readonly db: NativesDatabase, private readonly index: ContextIndex) {}

  refresh(document: vscode.TextDocument): void {
    if (document.languageId !== 'lua') return;
    const enabled = vscode.workspace
      .getConfiguration('perfectFivem', document.uri)
      .get<boolean>('natives.enableDiagnostics', true);
    if (!enabled || !this.db.isLoaded) {
      this.collection.delete(document.uri);
      return;
    }

    const fileContext = this.index.getFileContext(document.uri)?.context;
    if (!fileContext) {
      this.collection.delete(document.uri);
      return;
    }

    const deprecatedOverrides = new Set(
      vscode.workspace.getConfiguration('perfectFivem', document.uri).get<string[]>('natives.deprecatedOverrides', []),
    );

    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];
    let match: RegExpExecArray | null;
    CALL_RE.lastIndex = 0;
    while ((match = CALL_RE.exec(text))) {
      const name = match[1];
      const entries = this.db.getByLuaName(name);
      if (!entries.length) continue;

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + name.length);
      const range = new vscode.Range(startPos, endPos);

      const allowed = entries.filter((e) => isAllowedInContext(e.apiset, fileContext));
      if (!allowed.length) {
        const sides = [...new Set(entries.map((e) => e.apiset))].join('/');
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `'${name}' is a ${sides}-side native and is not available in this ${fileContext} script.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
        continue;
      }

      if (BUILTIN_DEPRECATED.has(name) || deprecatedOverrides.has(name)) {
        diagnostics.push(
          new vscode.Diagnostic(range, `'${name}' is deprecated.`, vscode.DiagnosticSeverity.Hint),
        );
      }
    }

    this.collection.set(document.uri, diagnostics);
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
