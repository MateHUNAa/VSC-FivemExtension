import * as vscode from 'vscode';
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
   * add/delete) because require() resolution depends on file *content*, not just its presence. */
  async refreshForFile(fsPath: string): Promise<void> {
    const root = this.scanner.getResourceForFile(fsPath);
    if (root) await this.rebuildResource(root);
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

  private async rebuildResource(root: ResourceRoot): Promise<void> {
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

    const [clientFiles, serverFiles, sharedFiles] = await Promise.all([
      this.resolvePatterns(root, manifest.clientPatterns),
      this.resolvePatterns(root, manifest.serverPatterns),
      this.resolvePatterns(root, manifest.sharedPatterns),
    ]);

    const directContexts = new Map<string, ScriptContext>();
    for (const f of sharedFiles) directContexts.set(f, 'shared');
    for (const f of clientFiles) {
      directContexts.set(f, directContexts.has(f) ? mergeContext(directContexts.get(f)!, 'client') : 'client');
    }
    for (const f of serverFiles) {
      directContexts.set(f, directContexts.has(f) ? mergeContext(directContexts.get(f)!, 'server') : 'server');
    }

    let requiredContexts: Map<string, ScriptContext>;
    try {
      requiredContexts = await resolveRequiredFiles(root, directContexts);
    } catch (err) {
      this.log.warn(`Failed to resolve require() graph for '${root.name}': ${String(err)}`);
      requiredContexts = new Map();
    }

    const fileContexts = new Map<string, { context: ScriptContext; via: ContextSource }>();
    for (const [fsPath, context] of directContexts) fileContexts.set(fsPath, { context, via: 'manifest' });
    for (const [fsPath, context] of requiredContexts) fileContexts.set(fsPath, { context, via: 'require' });

    const resourceKey = normalizePathKey(root.uri.fsPath);
    const previous = this.resourceStates.get(resourceKey);
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

    this.resourceStates.set(resourceKey, { root, manifest, fileContexts });
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

  private async resolvePatterns(root: ResourceRoot, patterns: string[]): Promise<string[]> {
    const results = new Set<string>();
    for (const pattern of patterns) {
      const vscodeGlob = normalizeFxGlobToVscodeGlob(pattern);
      try {
        const relative = new vscode.RelativePattern(root.uri, vscodeGlob);
        const files = await vscode.workspace.findFiles(relative);
        for (const f of files) results.add(normalizePathKey(f.fsPath));
      } catch (err) {
        this.log.warn(`Failed to resolve pattern '${pattern}' in '${root.name}': ${String(err)}`);
      }
    }
    return [...results];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeContext.dispose();
  }
}
