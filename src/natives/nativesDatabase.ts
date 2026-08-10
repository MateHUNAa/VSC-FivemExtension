import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ScriptContext } from '../core/types';

export type NativeApiSet = 'client' | 'server' | 'shared';

export interface NativeParam {
  name: string;
  type: string;
}

export interface NativeEntry {
  hash: string;
  name: string; // original SNAKE_CASE native name
  ns: string;
  apiset: NativeApiSet;
  params: NativeParam[];
  results: string;
  description?: string;
  resultsDescription?: string;
  /** PascalCase name as called from Lua, e.g. GET_ENTITY_COORDS -> GetEntityCoords. */
  luaName: string;
}

interface RawNative {
  hash: string;
  // Untrusted input (bundled data may include upstream gaps; a custom databasePath is fully
  // user-supplied) - some entries are legitimately unnamed/hash-only. See the null check in load().
  name: string | null;
  ns: string;
  apiset: NativeApiSet;
  params: NativeParam[];
  results: string;
  description?: string;
  resultsDescription?: string;
}

interface RawNativesFile {
  source: string;
  count: number;
  natives: RawNative[];
}

/** GET_ENTITY_COORDS -> GetEntityCoords (the calling convention FiveM's Lua runtime uses). */
export function toLuaName(nativeName: string): string {
  return nativeName
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/** Whether a native tagged with `apiset` should be offered while editing a file of `fileContext`. */
export function isAllowedInContext(apiset: NativeApiSet, fileContext: ScriptContext): boolean {
  if (fileContext === 'shared') return true;
  if (apiset === 'shared') return true;
  return apiset === fileContext;
}

export function buildNativeMarkdown(n: NativeEntry): vscode.MarkdownString {
  const paramsSig = n.params.map((p) => `${p.name}: ${p.type}`).join(', ');
  const md = new vscode.MarkdownString(undefined, true);
  md.appendCodeblock(`${n.results} ${n.luaName}(${paramsSig})`, 'lua');
  md.appendMarkdown(`**[${n.apiset}]** \`${n.ns}\` · \`${n.hash}\`\n\n`);
  if (n.description) md.appendMarkdown(`${n.description}\n\n`);
  if (n.params.length) {
    md.appendMarkdown('**Parameters**\n\n');
    for (const p of n.params) md.appendMarkdown(`- \`${p.name}\`: ${p.type}\n`);
    md.appendMarkdown('\n');
  }
  if (n.resultsDescription) md.appendMarkdown(`**Returns:** ${n.resultsDescription}\n`);
  return md;
}

/**
 * In-memory index over the bundled (or user-supplied) normalized natives.json, keyed by the
 * PascalCase Lua calling name. Built once at startup and reused for completion/hover/signature
 * help/diagnostics; never re-read from disk except on explicit reload.
 */
export class NativesDatabase implements vscode.Disposable {
  private byLuaNameLower = new Map<string, NativeEntry[]>();
  private loaded = false;
  private loadingPromise: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidReload = new vscode.EventEmitter<void>();
  readonly onDidReload = this._onDidReload.event;

  constructor(private readonly extensionUri: vscode.Uri, private readonly log: Logger) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('perfectFivem.natives.databasePath')) void this.reload();
      }),
    );
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get size(): number {
    let n = 0;
    for (const arr of this.byLuaNameLower.values()) n += arr.length;
    return n;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadingPromise) this.loadingPromise = this.load();
    await this.loadingPromise;
  }

  async reload(): Promise<void> {
    this.loaded = false;
    this.loadingPromise = undefined;
    await this.ensureLoaded();
    this._onDidReload.fire();
  }

  private resolveDatabaseUri(): vscode.Uri {
    const customPath = vscode.workspace.getConfiguration('perfectFivem').get<string>('natives.databasePath', '');
    return customPath ? vscode.Uri.file(customPath) : vscode.Uri.joinPath(this.extensionUri, 'data', 'natives.json');
  }

  private async load(): Promise<void> {
    const uri = this.resolveDatabaseUri();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as RawNativesFile;
      const next = new Map<string, NativeEntry[]>();
      let skipped = 0;
      for (const n of raw.natives) {
        // Undocumented/hash-only natives (no name) have no Lua calling convention and can't
        // be indexed by name - skip rather than let one bad entry (e.g. a custom
        // natives.databasePath) abort the whole load.
        if (!n.name) {
          skipped++;
          continue;
        }
        const luaName = toLuaName(n.name);
        const entry: NativeEntry = { ...n, name: n.name, luaName };
        const key = luaName.toLowerCase();
        const arr = next.get(key);
        if (arr) arr.push(entry);
        else next.set(key, [entry]);
      }
      this.byLuaNameLower = next;
      this.loaded = true;
      this.log.info(
        `Loaded ${raw.natives.length - skipped} natives from ${uri.fsPath}${skipped ? ` (skipped ${skipped} unnamed entries)` : ''}`,
      );
    } catch (err) {
      this.log.error(`Failed to load natives database from ${uri.fsPath}`, err);
      this.loaded = false;
    }
  }

  getByLuaName(name: string): NativeEntry[] {
    return this.byLuaNameLower.get(name.toLowerCase()) ?? [];
  }

  queryByPrefix(prefix: string, limit = 300): NativeEntry[] {
    if (!prefix) return [];
    const lower = prefix.toLowerCase();
    const out: NativeEntry[] = [];
    for (const [key, entries] of this.byLuaNameLower) {
      if (key.startsWith(lower)) {
        out.push(...entries);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidReload.dispose();
  }
}
