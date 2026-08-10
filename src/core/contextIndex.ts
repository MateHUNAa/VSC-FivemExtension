import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { normalizeFxGlobToVscodeGlob } from './glob';
import { parseManifest } from './manifestParser';
import { ResourceScanner } from './resourceScanner';
import { FileContextEntry, ParsedManifest, ResourceRoot, ScriptContext } from './types';

interface ResourceState {
  root: ResourceRoot;
  manifest: ParsedManifest;
  fileContexts: Map<string, ScriptContext>; // key: file fsPath
}

function mergeContext(existing: ScriptContext, incoming: ScriptContext): ScriptContext {
  if (existing === incoming) return existing;
  return 'shared'; // a file listed under both client and server is effectively shared
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

  getFileContext(uri: vscode.Uri): FileContextEntry | undefined {
    return this.fileIndex.get(uri.fsPath);
  }

  getResourceByName(name: string): ResourceRoot | undefined {
    return this.resourceByName.get(name.toLowerCase());
  }

  getManifest(root: ResourceRoot): ParsedManifest | undefined {
    return this.resourceStates.get(root.uri.fsPath)?.manifest;
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

    const fileContexts = new Map<string, ScriptContext>();
    for (const f of sharedFiles) fileContexts.set(f, 'shared');
    for (const f of clientFiles) {
      fileContexts.set(f, fileContexts.has(f) ? mergeContext(fileContexts.get(f)!, 'client') : 'client');
    }
    for (const f of serverFiles) {
      fileContexts.set(f, fileContexts.has(f) ? mergeContext(fileContexts.get(f)!, 'server') : 'server');
    }

    const previous = this.resourceStates.get(root.uri.fsPath);
    const changedFsPaths = new Set<string>();

    if (previous) {
      for (const fsPath of previous.fileContexts.keys()) {
        this.fileIndex.delete(fsPath);
        changedFsPaths.add(fsPath);
      }
    }
    for (const [fsPath, context] of fileContexts) {
      this.fileIndex.set(fsPath, { context, resource: root });
      changedFsPaths.add(fsPath);
    }

    this.resourceStates.set(root.uri.fsPath, { root, manifest, fileContexts });
    this.resourceByName.set(root.name.toLowerCase(), root);

    this._onDidChangeContext.fire([...changedFsPaths].map((p) => vscode.Uri.file(p)));
  }

  private removeResource(root: ResourceRoot): void {
    const state = this.resourceStates.get(root.uri.fsPath);
    if (!state) return;
    const changed: vscode.Uri[] = [];
    for (const fsPath of state.fileContexts.keys()) {
      this.fileIndex.delete(fsPath);
      changed.push(vscode.Uri.file(fsPath));
    }
    this.resourceStates.delete(root.uri.fsPath);
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
        for (const f of files) results.add(f.fsPath);
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
