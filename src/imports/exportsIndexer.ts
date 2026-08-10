import * as vscode from 'vscode';
import { ResourceScanner } from '../core/resourceScanner';
import { EventEntry, ExportEntry, ResourceRoot } from '../core/types';
import { Logger } from '../utils/logger';

const EXPORT_CALL_RE = /exports\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\(([^)]*)\)/g;
const EXPORT_ASSIGN_RE = /exports\.([A-Za-z_][\w]*)\s*=\s*function\s*\(([^)]*)\)/g;
const EVENT_REGISTER_RE = /\b(?:RegisterNetEvent|AddEventHandler)\s*\(\s*['"]([^'"]+)['"]/g;
const EVENT_TRIGGER_RE =
  /\b(?:TriggerEvent|TriggerServerEvent|TriggerClientEvent|TriggerLatentServerEvent|TriggerLatentClientEvent)\s*\(\s*['"]([^'"]+)['"]/g;

function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function splitParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractExports(text: string, resourceName: string, fileUri: vscode.Uri): ExportEntry[] {
  const out: ExportEntry[] = [];
  let m: RegExpExecArray | null;

  EXPORT_CALL_RE.lastIndex = 0;
  while ((m = EXPORT_CALL_RE.exec(text))) {
    out.push({
      name: m[1],
      params: splitParams(m[2]),
      resourceName,
      fileUri,
      line: offsetToLine(text, m.index),
    });
  }

  EXPORT_ASSIGN_RE.lastIndex = 0;
  while ((m = EXPORT_ASSIGN_RE.exec(text))) {
    out.push({
      name: m[1],
      params: splitParams(m[2]),
      resourceName,
      fileUri,
      line: offsetToLine(text, m.index),
    });
  }

  return out;
}

function extractEvents(text: string, resourceName: string, fileUri: vscode.Uri): EventEntry[] {
  const out: EventEntry[] = [];
  let m: RegExpExecArray | null;

  EVENT_REGISTER_RE.lastIndex = 0;
  while ((m = EVENT_REGISTER_RE.exec(text))) {
    out.push({ name: m[1], resourceName, fileUri, line: offsetToLine(text, m.index), kind: 'register' });
  }

  EVENT_TRIGGER_RE.lastIndex = 0;
  while ((m = EVENT_TRIGGER_RE.exec(text))) {
    out.push({ name: m[1], resourceName, fileUri, line: offsetToLine(text, m.index), kind: 'trigger' });
  }

  return out;
}

/**
 * Indexes `exports('name', function(...) end)` / `exports.name = function(...) end` declarations,
 * `RegisterNetEvent`/`AddEventHandler` registrations, and `TriggerEvent`-family call sites, all
 * per resource - so importCompletionProvider can offer real completions after
 * `exports['resource']:` / `exports.resource.` and inside event-name string literals, and so
 * go-to-definition/hover/CodeLens can jump between a handler and the calls that trigger it.
 */
export class ExportsIndexer implements vscode.Disposable {
  private exportsByResourcePath = new Map<string, ExportEntry[]>(); // key: resource folder fsPath
  private exportsByResourceName = new Map<string, ExportEntry[]>(); // key: lowercase resource name
  private eventsByResourcePath = new Map<string, EventEntry[]>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly scanner: ResourceScanner, private readonly log: Logger) {
    this.disposables.push(
      scanner.onDidAddResource((r) => void this.indexResource(r)),
      scanner.onDidChangeManifest((r) => void this.indexResource(r)),
      scanner.onDidChangeResourceFiles((r) => void this.indexResource(r)),
      scanner.onDidRemoveResource((r) => this.removeResource(r)),
    );
  }

  async initialBuild(): Promise<void> {
    await Promise.all(this.scanner.resources.map((r) => this.indexResource(r)));
  }

  getExports(resourceName: string): ExportEntry[] {
    return this.exportsByResourceName.get(resourceName.toLowerCase()) ?? [];
  }

  getEventNames(prefix = ''): string[] {
    const lower = prefix.toLowerCase();
    const names = new Set<string>();
    for (const entries of this.eventsByResourcePath.values()) {
      for (const e of entries) {
        if (e.name.toLowerCase().startsWith(lower)) names.add(e.name);
      }
    }
    return [...names];
  }

  getAllExports(): ExportEntry[] {
    return [...this.exportsByResourceName.values()].flat();
  }

  getAllEvents(): EventEntry[] {
    return [...this.eventsByResourcePath.values()].flat();
  }

  private async indexResource(root: ResourceRoot): Promise<void> {
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(new vscode.RelativePattern(root.uri, '**/*.lua'));
    } catch (err) {
      this.log.warn(`Failed to enumerate Lua files for '${root.name}': ${String(err)}`);
      return;
    }

    const exportEntries: ExportEntry[] = [];
    const eventEntries: EventEntry[] = [];
    for (const file of files) {
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        text = Buffer.from(bytes).toString('utf8');
      } catch {
        continue;
      }
      exportEntries.push(...extractExports(text, root.name, file));
      eventEntries.push(...extractEvents(text, root.name, file));
    }

    this.exportsByResourcePath.set(root.uri.fsPath, exportEntries);
    this.exportsByResourceName.set(root.name.toLowerCase(), exportEntries);
    this.eventsByResourcePath.set(root.uri.fsPath, eventEntries);
    this._onDidChange.fire();
  }

  private removeResource(root: ResourceRoot): void {
    this.exportsByResourcePath.delete(root.uri.fsPath);
    this.exportsByResourceName.delete(root.name.toLowerCase());
    this.eventsByResourcePath.delete(root.uri.fsPath);
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}
