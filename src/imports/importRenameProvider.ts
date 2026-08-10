import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { escapeRegExp, offsetToPosition } from '../utils/text';
import { findEventLiteralAt, findExportDeclarationAt, findExportsCallAt } from './importParser';

const VALID_IDENTIFIER_RE = /^[A-Za-z_]\w*$/;

type RenameTarget =
  | { kind: 'export'; resourceName: string; oldName: string }
  | { kind: 'event'; oldName: string };

interface Resolved {
  target: RenameTarget;
  range: vscode.Range;
}

function resolveTarget(
  document: vscode.TextDocument,
  position: vscode.Position,
  contextIndex: ContextIndex,
): Resolved | undefined {
  const lineText = document.lineAt(position.line).text;
  const character = position.character;

  const callSite = findExportsCallAt(lineText, character);
  if (callSite) {
    return {
      target: { kind: 'export', resourceName: callSite.resourceName, oldName: callSite.methodName },
      range: new vscode.Range(position.line, callSite.methodRange.start, position.line, callSite.methodRange.end),
    };
  }

  const decl = findExportDeclarationAt(lineText, character);
  if (decl) {
    const owner = contextIndex.getFileContext(document.uri)?.resource.name;
    if (!owner) return undefined;
    return {
      target: { kind: 'export', resourceName: owner, oldName: decl.methodName },
      range: new vscode.Range(position.line, decl.methodRange.start, position.line, decl.methodRange.end),
    };
  }

  const eventSite = findEventLiteralAt(lineText, character);
  if (eventSite) {
    return {
      target: { kind: 'event', oldName: eventSite.eventName },
      range: new vscode.Range(position.line, eventSite.nameRange.start, position.line, eventSite.nameRange.end),
    };
  }

  return undefined;
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Renames an export across the workspace: its `exports(...)`/`exports.name = function`
 * declaration (scoped to the owning resource's own files) plus every
 * `exports['resource']:name(...)` / `exports.resource:name(...)` / `exports.resource.name(...)`
 * call site anywhere in the workspace. */
async function renameExport(
  edit: vscode.WorkspaceEdit,
  contextIndex: ContextIndex,
  resourceName: string,
  oldName: string,
  newName: string,
  excludePattern: string | undefined,
): Promise<void> {
  const escapedName = escapeRegExp(oldName);
  const escapedResource = escapeRegExp(resourceName);

  const resourceRoot = contextIndex.getResourceByName(resourceName);
  if (resourceRoot) {
    const declFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(resourceRoot.uri, '**/*.lua'),
      excludePattern,
    );
    // exports('name', function...) - name ends right before the closing quote (1 trailing char).
    const callDeclRe = new RegExp(`exports\\s*\\(\\s*['"](${escapedName})['"]`, 'g');
    // exports.name = function - name sits right after the fixed "exports." prefix (0 trailing chars).
    const assignDeclRe = new RegExp(`exports\\.(${escapedName})\\s*=\\s*function`, 'g');
    for (const file of declFiles) {
      const text = await readFileText(file);
      if (text === undefined) continue;
      applyEditsWithTrailing(edit, file, text, callDeclRe, newName, 1);
      applyEditsAtFixedOffset(edit, file, text, assignDeclRe, newName, 'exports.'.length);
    }
  }

  const allFiles = await vscode.workspace.findFiles('**/*.lua', excludePattern);
  // exports['resource']:name / exports.resource:name / exports.resource.name - name is followed
  // by a word boundary (zero-width), so it ends exactly at the match's end.
  const bracketUseRe = new RegExp(`exports\\[['"]${escapedResource}['"]\\]\\s*:\\s*(${escapedName})\\b`, 'g');
  const dotUseRe = new RegExp(`exports\\.${escapedResource}\\s*[:.]\\s*(${escapedName})\\b`, 'g');
  for (const file of allFiles) {
    const text = await readFileText(file);
    if (text === undefined) continue;
    applyEditsWithTrailing(edit, file, text, bracketUseRe, newName, 0);
    applyEditsWithTrailing(edit, file, text, dotUseRe, newName, 0);
  }
}

/** Renames an event across the workspace: every `RegisterNetEvent`/`AddEventHandler`/
 * `TriggerEvent`/`TriggerServerEvent`/`TriggerClientEvent`/`TriggerLatent*Event` call whose
 * string-literal first argument matches `oldName`. */
async function renameEvent(
  edit: vscode.WorkspaceEdit,
  oldName: string,
  newName: string,
  excludePattern: string | undefined,
): Promise<void> {
  const escapedName = escapeRegExp(oldName);
  const files = await vscode.workspace.findFiles('**/*.lua', excludePattern);
  const re = new RegExp(
    `\\b(?:RegisterNetEvent|AddEventHandler|TriggerEvent|TriggerServerEvent|TriggerClientEvent|TriggerLatentServerEvent|TriggerLatentClientEvent)\\s*\\(\\s*['"](${escapedName})['"]`,
    'g',
  );
  for (const file of files) {
    const text = await readFileText(file);
    if (text === undefined) continue;
    applyEditsWithTrailing(edit, file, text, re, newName, 1);
  }
}

function applyEditsWithTrailing(
  edit: vscode.WorkspaceEdit,
  fileUri: vscode.Uri,
  text: string,
  re: RegExp,
  newName: string,
  trailingLen: number,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length - trailingLen;
    const start = end - m[1].length;
    edit.replace(fileUri, new vscode.Range(offsetToPosition(text, start), offsetToPosition(text, end)), newName);
  }
}

function applyEditsAtFixedOffset(
  edit: vscode.WorkspaceEdit,
  fileUri: vscode.Uri,
  text: string,
  re: RegExp,
  newName: string,
  prefixLen: number,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + prefixLen;
    const end = start + m[1].length;
    edit.replace(fileUri, new vscode.Range(offsetToPosition(text, start), offsetToPosition(text, end)), newName);
  }
}

/** Cross-file rename for exports and events: triggering on a declaration or any call/trigger
 * site renames the declaration and every other reference across the whole workspace. */
export class ImportsRenameProvider implements vscode.RenameProvider {
  constructor(private readonly contextIndex: ContextIndex) {}

  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    return resolveTarget(document, position, this.contextIndex)?.range;
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const resolved = resolveTarget(document, position, this.contextIndex);
    if (!resolved) return undefined;

    const excludeGlobs = vscode.workspace
      .getConfiguration('perfectFivem')
      .get<string[]>('resourceDetection.excludeGlobs', []);
    const excludePattern = excludeGlobs.length ? `{${excludeGlobs.join(',')}}` : undefined;

    const edit = new vscode.WorkspaceEdit();
    if (resolved.target.kind === 'export') {
      if (!VALID_IDENTIFIER_RE.test(newName)) {
        throw new Error('Export names must be valid Lua identifiers.');
      }
      await renameExport(edit, this.contextIndex, resolved.target.resourceName, resolved.target.oldName, newName, excludePattern);
    } else {
      if (!newName.trim() || /['"]/.test(newName)) {
        throw new Error('Event names must not be empty or contain quote characters.');
      }
      await renameEvent(edit, resolved.target.oldName, newName, excludePattern);
    }

    return edit;
  }
}
