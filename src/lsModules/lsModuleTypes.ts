import * as path from 'path';
import * as vscode from 'vscode';
import { ContextIndex } from '../core/contextIndex';
import { ResourceScanner } from '../core/resourceScanner';
import { ResourceRoot } from '../core/types';
import { ExportsIndexer } from '../imports/exportsIndexer';
import { Logger } from '../utils/logger';
import { normalizePathKey } from '../utils/paths';
import { emitMetaFile, ModuleSide, ResolvedMember, ResolvedModule } from './metaEmitter';
import {
  findReturnedTable,
  ModuleRegistration,
  moduleFileCandidates,
  parseModuleFile,
  parseRegistrations,
  surfaceSteps,
} from './moduleParser';

const REGENERATE_DEBOUNCE_MS = 500;
/** Relative to the workspace folder; LuaLS resolves relative library entries against it. */
const OUTPUT_DIR = '.vscode/perfect-fivem';
const OUTPUT_FILE = 'ls-modules.lua';

interface FileRegistrations {
  uri: vscode.Uri;
  registrations: ModuleRegistration[];
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

/** First candidate (relative to `root`) that exists on disk, with its text. */
async function firstExisting(
  root: ResourceRoot,
  candidates: string[],
): Promise<{ uri: vscode.Uri; rel: string; text: string } | undefined> {
  for (const rel of candidates) {
    const uri = vscode.Uri.joinPath(root.uri, ...rel.split('/'));
    const text = await readText(uri);
    if (text !== undefined) return { uri, rel, text };
  }
  return undefined;
}

/**
 * Generates a LuaLS `---@meta` file describing every module published through
 * `LS:RegisterModule(name, resource, path?)`, and registers its folder in the workspace's
 * `Lua.workspace.library`. ls_core resolves `LS.<Name>` lazily at runtime by loading the
 * module's `client`/`server`/`shared` file, so LuaLS can't see those members on its own - this
 * gives it real source text to read, with the module's own `---@param`/`---@return` annotations.
 */
export class LsModuleTypes implements vscode.Disposable {
  private readonly registrations = new Map<string, FileRegistrations>(); // key: normalized fsPath
  private readonly disposables: vscode.Disposable[] = [];
  private regenerateTimer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;

  constructor(
    private readonly scanner: ResourceScanner,
    private readonly contextIndex: ContextIndex,
    private readonly exportsIndex: ExportsIndexer,
    private readonly log: Logger,
  ) {
    const rescan = (root: ResourceRoot) => void this.scanResource(root).then(() => this.scheduleRegenerate());
    this.disposables.push(
      scanner.onDidAddResource(rescan),
      scanner.onDidChangeManifest(rescan),
      scanner.onDidChangeResourceFiles(rescan),
      scanner.onDidRemoveResource((root) => {
        this.dropResource(root);
        this.scheduleRegenerate();
      }),
      exportsIndex.onDidChange(() => this.scheduleRegenerate()),
      contextIndex.onDidChangeContext(() => this.scheduleRegenerate()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId !== 'lua' || doc.uri.scheme !== 'file') return;
        if (!scanner.getResourceForFile(doc.uri.fsPath)) return;
        // A module file has no RegisterModule call of its own, but its members still changed.
        this.updateFile(doc.uri, doc.getText());
        this.scheduleRegenerate();
      }),
    );
  }

  async initialBuild(): Promise<void> {
    this.registrations.clear();
    await Promise.all(this.scanner.resources.map((r) => this.scanResource(r)));
    this.ready = true;
    await this.regenerate();
  }

  async regenerate(): Promise<void> {
    if (this.regenerateTimer) clearTimeout(this.regenerateTimer);
    this.regenerateTimer = undefined;

    const all = [...this.registrations.values()];
    if (!all.length) return;

    const folder = vscode.workspace.getWorkspaceFolder(all[0].uri);
    if (!folder) return;

    let modules: ResolvedModule[];
    try {
      modules = await this.resolveModules(all);
    } catch (err) {
      this.log.error('LS modules: failed to resolve registered modules', err);
      return;
    }

    const outDir = vscode.Uri.joinPath(folder.uri, ...OUTPUT_DIR.split('/'));
    const outFile = vscode.Uri.joinPath(outDir, OUTPUT_FILE);
    const content = emitMetaFile(modules);
    if ((await readText(outFile)) !== content) {
      await vscode.workspace.fs.createDirectory(outDir);
      // The file holds absolute file:// links, so it never belongs in the repo.
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outDir, '.gitignore'), Buffer.from('*\n'));
      await vscode.workspace.fs.writeFile(outFile, Buffer.from(content, 'utf8'));
      this.log.info(`LS modules: wrote ${modules.length} module(s) to ${vscode.workspace.asRelativePath(outFile)}.`);
    }

    await this.ensureLibraryEntry(folder);
  }

  private scheduleRegenerate(): void {
    if (!this.ready) return;
    if (this.regenerateTimer) clearTimeout(this.regenerateTimer);
    this.regenerateTimer = setTimeout(() => void this.regenerate(), REGENERATE_DEBOUNCE_MS);
  }

  private async scanResource(root: ResourceRoot): Promise<void> {
    this.dropResource(root);
    await Promise.all(
      this.scanner.getLuaFilesForResource(root).map(async (uri) => {
        const text = await readText(uri);
        if (text !== undefined) this.updateFile(uri, text);
      }),
    );
  }

  private updateFile(uri: vscode.Uri, text: string): void {
    const key = normalizePathKey(uri.fsPath);
    const registrations = text.includes('RegisterModule') ? parseRegistrations(text) : [];
    if (registrations.length) this.registrations.set(key, { uri, registrations });
    else this.registrations.delete(key);
  }

  private dropResource(root: ResourceRoot): void {
    const prefix = normalizePathKey(root.uri.fsPath) + path.sep;
    for (const key of [...this.registrations.keys()]) if (key.startsWith(prefix)) this.registrations.delete(key);
  }

  private sidesOf(uri: vscode.Uri): ModuleSide[] {
    const context = this.contextIndex.getFileContext(uri)?.context;
    return context === 'client' || context === 'server' ? [context] : ['client', 'server'];
  }

  private async resolveModules(files: FileRegistrations[]): Promise<ResolvedModule[]> {
    const byName = new Map<string, ResolvedModule & { targets: Map<ModuleSide, ResourceRoot> }>();

    for (const { uri, registrations } of files) {
      const owner = this.scanner.getResourceForFile(uri.fsPath);
      for (const reg of registrations) {
        const targetName = reg.resourceName ?? owner?.name;
        const target = targetName ? this.contextIndex.getResourceByName(targetName) : undefined;
        if (!target) {
          this.log.warn(`LS modules: '${reg.moduleName}' targets unknown resource '${targetName}' (${uri.fsPath}:${reg.line + 1}).`);
          continue;
        }

        let mod = byName.get(reg.moduleName);
        if (!mod) {
          mod = { name: reg.moduleName, resourceName: target.name, dir: reg.path, sides: {}, unresolvedSides: [], targets: new Map() };
          byName.set(reg.moduleName, mod);
        }
        for (const side of this.sidesOf(uri)) {
          if (mod.targets.has(side)) continue;
          mod.targets.set(side, target);
          const members = await this.resolveSide(target, reg.path, side);
          if (members) mod.sides[side] = members;
          else mod.unresolvedSides.push(side);
        }
      }
    }
    return [...byName.values()];
  }

  /** Mirrors ls_core's `loadModule`: shared file first, then the side's own file on top. */
  private async resolveSide(root: ResourceRoot, dir: string, side: ModuleSide): Promise<ResolvedMember[] | undefined> {
    const candidates = moduleFileCandidates(dir, side);
    const [contextFile, sharedFile] = await Promise.all([
      firstExisting(root, candidates.context),
      firstExisting(root, candidates.shared),
    ]);
    const tableName =
      (contextFile && findReturnedTable(contextFile.text)) ?? (sharedFile && findReturnedTable(sharedFile.text));
    if (!tableName) return undefined;

    const members = new Map<string, ResolvedMember>();
    for (const file of [sharedFile, contextFile]) {
      if (!file) continue;
      const surface = parseModuleFile(file.text, tableName);
      const display = `${root.name}/${file.rel}`;

      for (const step of surfaceSteps(surface)) {
        if (step.kind === 'member') {
          const m = step.member;
          members.set(m.name, { ...m, source: { fsPath: file.uri.fsPath, line: m.line, display } });
        } else if (step.kind === 'forward') {
          const fwd = step.forward;
          for (const exportName of fwd.exportNames) {
            members.set(exportName, this.forwardedMember(exportName, fwd.resourceName, fwd.separator, side) ?? {
              name: exportName,
              kind: 'function',
              separator: fwd.separator,
              params: ['...'],
              doc: [],
              source: { fsPath: file.uri.fsPath, line: fwd.line, display },
            });
          }
        } else {
          const target = members.get(step.alias.target);
          if (target) members.set(step.alias.alias, { ...target, name: step.alias.alias, aliasOf: step.alias.target });
        }
      }
    }
    return [...members.values()];
  }

  /** The export a forwarding loop points at, preferring the one declared for `side`. */
  private forwardedMember(
    exportName: string,
    resourceName: string,
    separator: ':' | '.',
    side: ModuleSide,
  ): ResolvedMember | undefined {
    const candidates = this.exportsIndex.getExports(resourceName).filter((e) => e.name === exportName);
    const onSide = candidates.find((e) => {
      const context = this.contextIndex.getFileContext(e.fileUri)?.context;
      return context === side || context === 'shared';
    });
    const entry = onSide ?? candidates[0];
    if (!entry) return undefined;
    const root = this.scanner.getResourceForFile(entry.fileUri.fsPath);
    const rel = root ? path.relative(root.uri.fsPath, entry.fileUri.fsPath).split(path.sep).join('/') : path.basename(entry.fileUri.fsPath);
    return {
      name: exportName,
      kind: 'function',
      separator,
      params: entry.params,
      doc: entry.doc,
      source: { fsPath: entry.fileUri.fsPath, line: entry.line, display: `${entry.resourceName}/${rel}` },
    };
  }

  /** Adds OUTPUT_DIR to the workspace `Lua.workspace.library`. VS Code replaces (not merges)
   * array settings across scopes, so the first write seeds the list with the user-level entries
   * (cfxlua runtime/natives) - otherwise adding ours would silently drop them. */
  private async ensureLibraryEntry(folder: vscode.WorkspaceFolder): Promise<void> {
    const config = vscode.workspace.getConfiguration('Lua', folder.uri);
    const info = config.inspect<string[]>('workspace.library');
    if (!info) {
      this.log.warn('LS modules: Lua.workspace.library is not a known setting - is the Lua (sumneko) extension installed?');
      return;
    }

    const multiRoot = !!vscode.workspace.workspaceFile;
    const current = multiRoot ? info.workspaceFolderValue : info.workspaceValue;
    const normalized = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (current?.some((p) => normalized(p) === OUTPUT_DIR)) return;

    const next = [...(current ?? info.globalValue ?? []), OUTPUT_DIR];
    try {
      await config.update(
        'workspace.library',
        next,
        multiRoot ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace,
      );
      this.log.info(`LS modules: added '${OUTPUT_DIR}' to the workspace Lua.workspace.library.`);
    } catch (err) {
      this.log.error('LS modules: failed to update Lua.workspace.library', err);
    }
  }

  dispose(): void {
    if (this.regenerateTimer) clearTimeout(this.regenerateTimer);
    for (const d of this.disposables) d.dispose();
  }
}
