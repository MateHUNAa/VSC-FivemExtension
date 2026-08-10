import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { ScriptContext } from '../core/types';
import { isAllowedInContext, NativesDatabase } from './nativesDatabase';

// A small built-in starting point; extend via perfectFivem.natives.deprecatedOverrides.
const BUILTIN_DEPRECATED = new Set<string>(['SetPedAmmo', 'GetPedAmmoInClip', 'GetPlayerInvincible']);

// These are CitizenFX Lua-runtime built-ins, not natives (no hash, not in NativesDatabase),
// so they'd otherwise be invisible to the native-lookup check below entirely. Only the
// genuinely one-sided ones are listed - TriggerEvent/RegisterNetEvent/AddEventHandler/
// RegisterCommand are valid on both sides and would just be noise here.
const RUNTIME_EVENT_FUNCTION_SIDE: Record<string, ScriptContext> = {
  TriggerServerEvent: 'client',
  TriggerLatentServerEvent: 'client',
  TriggerClientEvent: 'server',
  TriggerLatentClientEvent: 'server',
};

const CALL_RE = /\b([A-Z][A-Za-z0-9]*)\s*\(/g;
const SUPPRESS_LINE_RE = /--\s*perfectfivem-ignore\b/i;

export const DIAGNOSTIC_SOURCE = 'Perfect FiveM';

/** Stable `diagnostic.code` values so code-action providers can match on intent instead of
 * parsing the human-readable message. */
export const enum DiagnosticCode {
  WrongSideRuntimeFunction = 'wrong-side-runtime-function',
  WrongSideNative = 'wrong-side-native',
  DeprecatedNative = 'deprecated-native',
}

/**
 * Flags natives (and the handful of one-sided CitizenFX runtime event functions above) used on
 * the wrong side, plus a small curated set of deprecated natives. Deliberately does NOT flag
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
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + name.length);
      const range = new vscode.Range(startPos, endPos);

      if (SUPPRESS_LINE_RE.test(document.lineAt(startPos.line).text)) continue;

      const requiredSide = RUNTIME_EVENT_FUNCTION_SIDE[name];
      if (requiredSide) {
        if (!isAllowedInContext(requiredSide, fileContext)) {
          const d = new vscode.Diagnostic(
            range,
            `'${name}' is meant to be called from ${requiredSide}-side code, not from this ${fileContext} script.`,
            vscode.DiagnosticSeverity.Warning,
          );
          d.source = DIAGNOSTIC_SOURCE;
          d.code = DiagnosticCode.WrongSideRuntimeFunction;
          diagnostics.push(d);
        }
        continue;
      }

      const entries = this.db.getByLuaName(name);
      if (!entries.length) continue;

      const allowed = entries.filter((e) => isAllowedInContext(e.apiset, fileContext));
      if (!allowed.length) {
        const sides = [...new Set(entries.map((e) => e.apiset))].join('/');
        const d = new vscode.Diagnostic(
          range,
          `'${name}' is a ${sides}-side native and is not available in this ${fileContext} script.`,
          vscode.DiagnosticSeverity.Warning,
        );
        d.source = DIAGNOSTIC_SOURCE;
        d.code = DiagnosticCode.WrongSideNative;
        diagnostics.push(d);
        continue;
      }

      if (BUILTIN_DEPRECATED.has(name) || deprecatedOverrides.has(name)) {
        const d = new vscode.Diagnostic(range, `'${name}' is deprecated.`, vscode.DiagnosticSeverity.Hint);
        d.source = DIAGNOSTIC_SOURCE;
        d.code = DiagnosticCode.DeprecatedNative;
        diagnostics.push(d);
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
