import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { normalizePathKey } from '../utils/paths';
import { ManifestKind, ResourceRoot } from './types';

const DEBOUNCE_MS = 150;

function getExcludeGlob(): string {
  const globs = vscode.workspace
    .getConfiguration('perfectFivem')
    .get<string[]>('resourceDetection.excludeGlobs', []);
  return globs.length ? `{${globs.join(',')}}` : '';
}

/**
 * Discovers FiveM resource roots (folders containing fxmanifest.lua or the legacy
 * __resource.lua) across the workspace and keeps the set up to date via file watchers.
 * This class only tracks *which folders are resources*; script parsing/context resolution
 * lives in ContextIndex, which subscribes to the events below.
 */
export class ResourceScanner implements vscode.Disposable {
  private readonly roots = new Map<string, ResourceRoot>(); // key: resource folder fsPath
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingFileChange = new Map<string, ReturnType<typeof setTimeout>>();
  private watchersInitialized = false;
  /** Every *.lua file in the workspace (fsPath, normalized), kept up to date by the file watcher
   * below. Populated by a single `findFiles` scan instead of one-per-resource so consumers
   * (ContextIndex, TableMethodIndexer, ExportsIndexer) never need to search the filesystem
   * themselves - each `findFiles` call spawns its own ripgrep process, and with many resources
   * building in parallel that turned into dozens of concurrent rg processes. */
  private readonly allLuaFiles = new Set<string>(); // key: normalized fsPath

  private readonly _onDidAddResource = new vscode.EventEmitter<ResourceRoot>();
  private readonly _onDidRemoveResource = new vscode.EventEmitter<ResourceRoot>();
  private readonly _onDidChangeManifest = new vscode.EventEmitter<ResourceRoot>();
  private readonly _onDidChangeResourceFiles = new vscode.EventEmitter<ResourceRoot>();

  readonly onDidAddResource = this._onDidAddResource.event;
  readonly onDidRemoveResource = this._onDidRemoveResource.event;
  /** Fired when a resource's manifest file itself is created/changed (needs a full re-parse). */
  readonly onDidChangeManifest = this._onDidChangeManifest.event;
  /** Fired when a *.lua file inside a known resource is added/removed (glob patterns need re-resolving, manifest text is unchanged). */
  readonly onDidChangeResourceFiles = this._onDidChangeResourceFiles.event;

  constructor(private readonly log: Logger) {}

  get resources(): ResourceRoot[] {
    return [...this.roots.values()];
  }

  getResourceForFile(fsPath: string): ResourceRoot | undefined {
    let dir = normalizePathKey(path.dirname(fsPath));
    while (true) {
      const root = this.roots.get(dir);
      if (root) return root;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /** Every known *.lua file inside `root`, from the shared in-memory list (no filesystem search). */
  getLuaFilesForResource(root: ResourceRoot): vscode.Uri[] {
    const prefix = normalizePathKey(root.uri.fsPath) + path.sep;
    const result: vscode.Uri[] = [];
    for (const fsPath of this.allLuaFiles) {
      if (fsPath.startsWith(prefix)) result.push(vscode.Uri.file(fsPath));
    }
    return result;
  }

  /** Runs a full workspace scan. Safe to call repeatedly (e.g. from the "Rescan Workspace" command); watchers are only ever set up once. */
  async initialScan(): Promise<void> {
    const excludeGlob = getExcludeGlob();
    const exclude = excludeGlob || undefined;
    const [manifests, legacy, luaFiles] = await Promise.all([
      vscode.workspace.findFiles('**/fxmanifest.lua', exclude),
      vscode.workspace.findFiles('**/__resource.lua', exclude),
      vscode.workspace.findFiles('**/*.lua', exclude),
    ]);

    this.allLuaFiles.clear();
    for (const uri of luaFiles) this.allLuaFiles.add(normalizePathKey(uri.fsPath));

    const found = new Set<string>();
    for (const uri of manifests) {
      found.add(normalizePathKey(path.dirname(uri.fsPath)));
      this.registerRoot(uri, 'fxmanifest', /*silent*/ true);
    }
    for (const uri of legacy) {
      const folder = normalizePathKey(path.dirname(uri.fsPath));
      if (!found.has(folder)) {
        found.add(folder);
        this.registerRoot(uri, 'legacy', /*silent*/ true);
      }
    }
    for (const folder of [...this.roots.keys()]) {
      if (!found.has(folder)) this.unregisterRoot(folder);
    }

    this.log.info(`Scan found ${this.roots.size} resource root(s).`);
    if (!this.watchersInitialized) {
      this.watchersInitialized = true;
      this.setupWatchers();
    }
  }

  private registerRoot(manifestUri: vscode.Uri, kind: ManifestKind, silent = false): ResourceRoot {
    const folderUri = vscode.Uri.file(path.dirname(manifestUri.fsPath));
    const key = normalizePathKey(folderUri.fsPath);
    const alreadyExisted = this.roots.has(key);
    const root: ResourceRoot = {
      uri: folderUri,
      name: path.basename(folderUri.fsPath),
      manifestUri,
      manifestKind: kind,
    };
    this.roots.set(key, root);
    if (!silent && !alreadyExisted) this._onDidAddResource.fire(root);
    return root;
  }

  private unregisterRoot(folderFsPath: string): void {
    const key = normalizePathKey(folderFsPath);
    const root = this.roots.get(key);
    if (!root) return;
    this.roots.delete(key);
    this._onDidRemoveResource.fire(root);
  }

  private setupWatchers(): void {
    const manifestWatcher = vscode.workspace.createFileSystemWatcher('**/fxmanifest.lua');
    manifestWatcher.onDidCreate((uri) => {
      const root = this.registerRoot(uri, 'fxmanifest');
      this._onDidChangeManifest.fire(root);
    });
    manifestWatcher.onDidChange((uri) => {
      const root = this.roots.get(normalizePathKey(path.dirname(uri.fsPath)));
      if (root) this._onDidChangeManifest.fire(root);
    });
    manifestWatcher.onDidDelete((uri) => {
      this.unregisterRoot(path.dirname(uri.fsPath));
    });
    this.disposables.push(manifestWatcher);

    const legacyWatcher = vscode.workspace.createFileSystemWatcher('**/__resource.lua');
    legacyWatcher.onDidCreate((uri) => {
      const folder = normalizePathKey(path.dirname(uri.fsPath));
      if (this.roots.has(folder)) return; // fxmanifest.lua already covers this folder
      const root = this.registerRoot(uri, 'legacy');
      this._onDidChangeManifest.fire(root);
    });
    legacyWatcher.onDidChange((uri) => {
      const root = this.roots.get(normalizePathKey(path.dirname(uri.fsPath)));
      if (root && root.manifestKind === 'legacy') this._onDidChangeManifest.fire(root);
    });
    legacyWatcher.onDidDelete((uri) => {
      const folder = normalizePathKey(path.dirname(uri.fsPath));
      const root = this.roots.get(folder);
      if (root && root.manifestKind === 'legacy') this.unregisterRoot(folder);
    });
    this.disposables.push(legacyWatcher);

    const luaWatcher = vscode.workspace.createFileSystemWatcher('**/*.lua');
    luaWatcher.onDidCreate((uri) => {
      this.allLuaFiles.add(normalizePathKey(uri.fsPath));
      this.scheduleFileChange(uri);
    });
    luaWatcher.onDidDelete((uri) => {
      this.allLuaFiles.delete(normalizePathKey(uri.fsPath));
      this.scheduleFileChange(uri);
    });
    this.disposables.push(luaWatcher);
  }

  private scheduleFileChange(uri: vscode.Uri): void {
    const root = this.getResourceForFile(uri.fsPath);
    if (!root) return;
    const key = root.uri.fsPath;
    const existing = this.pendingFileChange.get(key);
    if (existing) clearTimeout(existing);
    this.pendingFileChange.set(
      key,
      setTimeout(() => {
        this.pendingFileChange.delete(key);
        this._onDidChangeResourceFiles.fire(root);
      }, DEBOUNCE_MS),
    );
  }

  dispose(): void {
    for (const t of this.pendingFileChange.values()) clearTimeout(t);
    this.pendingFileChange.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this._onDidAddResource.dispose();
    this._onDidRemoveResource.dispose();
    this._onDidChangeManifest.dispose();
    this._onDidChangeResourceFiles.dispose();
  }
}
