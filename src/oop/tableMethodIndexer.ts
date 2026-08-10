import * as vscode from 'vscode';
import { ResourceScanner } from '../core/resourceScanner';
import { ResourceRoot } from '../core/types';
import { Logger } from '../utils/logger';

export interface TableMethodEntry {
  tableName: string;
  methodName: string;
  params: string[];
  style: ':' | '.';
  fileUri: vscode.Uri;
  line: number;
}

const METHOD_DECL_RE = /\bfunction\s+([A-Za-z_]\w*)\s*([:.])\s*([A-Za-z_]\w*)\s*\(([^)]*)\)/g;

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
    .filter((p) => p && p !== 'self');
}

function extractTableMethods(text: string, fileUri: vscode.Uri): TableMethodEntry[] {
  const out: TableMethodEntry[] = [];
  let m: RegExpExecArray | null;
  METHOD_DECL_RE.lastIndex = 0;
  while ((m = METHOD_DECL_RE.exec(text))) {
    out.push({
      tableName: m[1],
      methodName: m[3],
      params: splitParams(m[4]),
      style: m[2] as ':' | '.',
      fileUri,
      line: offsetToLine(text, m.index),
    });
  }
  return out;
}

/**
 * Indexes `function Table:Method(...)` / `function Table.Method(...)` declarations across a
 * resource's Lua files, keyed by resource + table name. This is a lightweight, pattern-based
 * complement to a real Lua language server (see README "OOP completion") - no type inference
 * or scope resolution, just a name match. That means it can over-suggest across unrelated
 * same-named tables within the same resource; it's intentionally scoped that small.
 */
export class TableMethodIndexer implements vscode.Disposable {
  private readonly methodsByResourcePath = new Map<string, TableMethodEntry[]>(); // key: resource folder fsPath
  private readonly methodsByTableKey = new Map<string, TableMethodEntry[]>(); // key: `${resourceFsPath}::${tableNameLower}`
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

  getMethods(resource: ResourceRoot, tableName: string): TableMethodEntry[] {
    return this.methodsByTableKey.get(this.tableKey(resource, tableName)) ?? [];
  }

  private tableKey(resource: ResourceRoot, tableName: string): string {
    return `${resource.uri.fsPath}::${tableName.toLowerCase()}`;
  }

  private async indexResource(root: ResourceRoot): Promise<void> {
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(new vscode.RelativePattern(root.uri, '**/*.lua'));
    } catch (err) {
      this.log.warn(`Failed to enumerate Lua files for '${root.name}': ${String(err)}`);
      return;
    }

    const entries: TableMethodEntry[] = [];
    for (const file of files) {
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        text = Buffer.from(bytes).toString('utf8');
      } catch {
        continue;
      }
      entries.push(...extractTableMethods(text, file));
    }

    this.clearResourceTableKeys(root);
    this.methodsByResourcePath.set(root.uri.fsPath, entries);
    for (const e of entries) {
      const key = this.tableKey(root, e.tableName);
      const arr = this.methodsByTableKey.get(key);
      if (arr) arr.push(e);
      else this.methodsByTableKey.set(key, [e]);
    }

    this._onDidChange.fire();
  }

  private clearResourceTableKeys(root: ResourceRoot): void {
    const prefix = `${root.uri.fsPath}::`;
    for (const key of [...this.methodsByTableKey.keys()]) {
      if (key.startsWith(prefix)) this.methodsByTableKey.delete(key);
    }
  }

  private removeResource(root: ResourceRoot): void {
    this.methodsByResourcePath.delete(root.uri.fsPath);
    this.clearResourceTableKeys(root);
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}
