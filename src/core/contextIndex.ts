import * as path from 'path';
import * as vscode from 'vscode';
import { compileGlob } from '../utils/miniglob';
import { Logger } from '../utils/logger';
import { normalizePathKey } from '../utils/paths';
import { normalizeFxGlobToVscodeGlob } from './glob';
import { parseManifest } from './manifestParser';
import { resolveRequiredFiles } from './requireResolver';
import { ResourceScanner } from './resourceScanner';
import { mergeContext } from './scriptContext';
import { ContextSource, FileContextEntry, ParsedManifest, ResourceRoot, ScriptContext } from './types';

interface ResourceState {
  root: ResourceRoot;
  manifest: ParsedManifest;
  fileContexts: Map<string, { context: ScriptContext; via: ContextSource }>; // key: file fsPath
  requiresOf: Map<string, string[]>; // require() graph cache, see resolveRequiredFiles
}

/**
 * The single source of truth mapping every Lua file to its resource + script context.
 * Consumers (explorer decorations, native completion/hover/diagnostics) only ever read
 * from the precomputed maps here - they never touch the filesystem or re-parse a manifest.
 */
export class ContextIndex implements vscode.Disposable {
  private readonly resourceStates = new Map<string, ResourceState>(); // key: resource folder fsPath
  private readonly fileIndex = new Map<string, FileContextEntry>(); // key: file fsPath
  private readonly resourceByName = new Map<string, ResourceRoot>(); // key: lowercase resource name
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeContext = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeContext = this._onDidChangeContext.event;

  constructor(private readonly scanner: ResourceScanner, private readonly log: Logger) {
    this.disposables.push(
      scanner.onDidAddResource((r) => void this.rebuildResource(r)),
      scanner.onDidChangeManifest((r) => void this.rebuildResource(r)),
      scanner.onDidChangeResourceFiles((r) => void this.rebuildResource(r)),
      scanner.onDidRemoveResource((r) => this.removeResource(r)),
    );
  }

  async initialBuild(): Promise<void> {
    await Promise.all(this.scanner.resources.map((r) => this.rebuildResource(r)));
  }

  /** Re-resolves the resource owning `fsPath`, if any. Needed on save (not just file
   * add/delete) because require() resolution depends on file *content*, not just its presence.
   * Only `fsPath` itself is re-read from disk for its require() list - every other file in the
   * resource's require graph reuses its cached result (see ResourceState.requiresOf). */
  async refreshForFile(fsPath: string): Promise<void> {
    const root = this.scanner.getResourceForFile(fsPath);
    if (root) await this.rebuildResource(root, normalizePathKey(fsPath));
  }

  getFileContext(uri: vscode.Uri): FileContextEntry | undefined {
    return this.fileIndex.get(normalizePathKey(uri.fsPath));
  }

  getResourceByName(name: string): ResourceRoot | undefined {
    return this.resourceByName.get(name.toLowerCase());
  }

  getManifest(root: ResourceRoot): ParsedManifest | undefined {
    return this.resourceStates.get(normalizePathKey(root.uri.fsPath))?.manifest;
  }

  get allResources(): ResourceRoot[] {
    return this.scanner.resources;
  }

  getAllResourceStates(): { root: ResourceRoot; manifest: ParsedManifest }[] {
    return [...this.resourceStates.values()].map((s) => ({ root: s.root, manifest: s.manifest }));
  }

  /** `staleFile` (normalized fsPath), when given, is the single file known to have changed
   * content (a save) - the require() graph cache is reused for every other file. Omit it for a
   * full rebuild (initial build, file add/delete, manifest change), where the cache is reset
   * since the set of files itself may have changed. */
  private async rebuildResource(root: ResourceRoot, staleFile?: string): Promise<void> {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(root.manifestUri);
      text = Buffer.from(bytes).toString('utf8');
    } catch (err) {
      this.log.warn(`Could not read manifest for '${root.name}': ${String(err)}`);
      return;
    }

    const manifest = parseManifest(text, root.name);
    if (manifest.malformed) {
      this.log.warn(`Malformed manifest in '${root.name}': ${manifest.errors.join('; ') || 'unknown error'}`);
    }

    const clientFiles = this.resolvePatterns(root, manifest.clientPatterns);
    const serverFiles = this.resolvePatterns(root, manifest.serverPatterns);
    const sharedFiles = this.resolvePatterns(root, manifest.sharedPatterns);

    const directContexts = new Map<string, ScriptContext>();
    for (const f of sharedFiles) directContexts.set(f, 'shared');
    for (const f of clientFiles) {
      directContexts.set(f, directContexts.has(f) ? mergeContext(directContexts.get(f)!, 'client') : 'client');
    }
    for (const f of serverFiles) {
      directContexts.set(f, directContexts.has(f) ? mergeContext(directContexts.get(f)!, 'server') : 'server');
    }

    const resourceKey = normalizePathKey(root.uri.fsPath);
    const previous = this.resourceStates.get(resourceKey);
    const requiresOf = staleFile && previous ? previous.requiresOf : new Map<string, string[]>();

    let requiredContexts: Map<string, ScriptContext>;
    try {
      requiredContexts = await resolveRequiredFiles(
        root,
        directContexts,
        requiresOf,
        staleFile ? new Set([staleFile]) : undefined,
      );
    } catch (err) {
      this.log.warn(`Failed to resolve require() graph for '${root.name}': ${String(err)}`);
      requiredContexts = new Map();
    }

    const fileContexts = new Map<string, { context: ScriptContext; via: ContextSource }>();
    for (const [fsPath, context] of directContexts) fileContexts.set(fsPath, { context, via: 'manifest' });
    for (const [fsPath, context] of requiredContexts) fileContexts.set(fsPath, { context, via: 'require' });

    const changedFsPaths = new Set<string>();

    if (previous) {
      for (const fsPath of previous.fileContexts.keys()) {
        this.fileIndex.delete(fsPath);
        changedFsPaths.add(fsPath);
      }
    }
    for (const [fsPath, entry] of fileContexts) {
      this.fileIndex.set(fsPath, { context: entry.context, via: entry.via, resource: root });
      changedFsPaths.add(fsPath);
    }

    this.resourceStates.set(resourceKey, { root, manifest, fileContexts, requiresOf });
    this.resourceByName.set(root.name.toLowerCase(), root);

    this._onDidChangeContext.fire([...changedFsPaths].map((p) => vscode.Uri.file(p)));
  }

  private removeResource(root: ResourceRoot): void {
    const resourceKey = normalizePathKey(root.uri.fsPath);
    const state = this.resourceStates.get(resourceKey);
    if (!state) return;
    const changed: vscode.Uri[] = [];
    for (const fsPath of state.fileContexts.keys()) {
      this.fileIndex.delete(fsPath);
      changed.push(vscode.Uri.file(fsPath));
    }
    this.resourceStates.delete(resourceKey);
    this.resourceByName.delete(root.name.toLowerCase());
    this._onDidChangeContext.fire(changed);
  }

  /** Matches fxmanifest script patterns against the resource's already-known Lua file list
   * in memory, instead of issuing a `findFiles` search per pattern (each of which spawns its
   * own ripgrep process - with many patterns across many resources building in parallel, that
   * was launching dozens of concurrent rg processes on activation). */
  private resolvePatterns(root: ResourceRoot, patterns: string[]): string[] {
    const luaFiles = this.scanner.getLuaFilesForResource(root);
    const results = new Set<string>();
    for (const pattern of patterns) {
      const vscodeGlob = normalizeFxGlobToVscodeGlob(pattern);
      let re: RegExp;
      try {
        re = compileGlob(vscodeGlob);
      } catch (err) {
        this.log.warn(`Failed to compile pattern '${pattern}' in '${root.name}': ${String(err)}`);
        continue;
      }
      for (const file of luaFiles) {
        const rel = path.relative(root.uri.fsPath, file.fsPath).split(path.sep).join('/');
        if (re.test(rel)) results.add(normalizePathKey(file.fsPath));
      }
    }
    return [...results];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeContext.dispose();
  }
}
