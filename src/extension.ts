import * as vscode from 'vscode';
import { ContextIndex } from './core/contextIndex';
import { ResourceScanner } from './core/resourceScanner';
import { ContextFileDecorationProvider } from './decorations/fileDecorationProvider';
import { ExportsIndexer } from './imports/exportsIndexer';
import { ExportsCompletionProvider, EventNameCompletionProvider } from './imports/importCompletionProvider';
import { ExportsEventsDefinitionProvider, ExportsEventsHoverProvider } from './imports/importDefinitionHoverProvider';
import { ImportsEventCodeLensProvider } from './imports/importEventCodeLensProvider';
import { ImportsRenameProvider } from './imports/importRenameProvider';
import { ImportsWorkspaceSymbolProvider } from './imports/importWorkspaceSymbolProvider';
import { NativeCompletionProvider } from './natives/completionProvider';
import { NativeQuickFixProvider } from './natives/codeActionProvider';
import { NativeContextDiagnostics } from './natives/diagnostics';
import { NativeHoverProvider } from './natives/hoverProvider';
import { NativesDatabase } from './natives/nativesDatabase';
import { NativeSignatureHelpProvider } from './natives/signatureHelpProvider';
import { TableMethodCompletionProvider } from './oop/tableMethodCompletionProvider';
import { TableMethodIndexer } from './oop/tableMethodIndexer';
import { RconManager } from './rcon/rconManager';
import { Logger } from './utils/logger';
import { normalizePathKey } from './utils/paths';

const LUA_SELECTOR: vscode.DocumentSelector = { language: 'lua', scheme: 'file' };
const DIAGNOSTIC_DEBOUNCE_MS = 300;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new Logger();
  context.subscriptions.push(log);

  const scanner = new ResourceScanner(log);
  const contextIndex = new ContextIndex(scanner, log);
  const exportsIndex = new ExportsIndexer(scanner, log);
  const tableMethodIndexer = new TableMethodIndexer(scanner, log);
  const nativesDb = new NativesDatabase(context.extensionUri, log);
  context.subscriptions.push(scanner, contextIndex, exportsIndex, tableMethodIndexer, nativesDb);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Perfect FiveM: scanning workspace…' },
    async () => {
      await scanner.initialScan();
      await Promise.all([
        contextIndex.initialBuild(),
        exportsIndex.initialBuild(),
        tableMethodIndexer.initialBuild(),
        nativesDb.ensureLoaded(),
      ]);
    },
  );
  log.info(`Ready: ${scanner.resources.length} resource(s), ${nativesDb.size} natives indexed.`);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await scanner.initialScan();
      await Promise.all([contextIndex.initialBuild(), exportsIndex.initialBuild(), tableMethodIndexer.initialBuild()]);
    }),
  );

  const config = vscode.workspace.getConfiguration('perfectFivem');

  // --- Explorer decorations -------------------------------------------------
  if (config.get<boolean>('decorations.enable', true)) {
    const decorationProvider = new ContextFileDecorationProvider(contextIndex);
    context.subscriptions.push(decorationProvider, vscode.window.registerFileDecorationProvider(decorationProvider));
  }

  // --- Native IntelliSense ---------------------------------------------------
  if (config.get<boolean>('natives.enable', true)) {
    const completionProvider = new NativeCompletionProvider(nativesDb, contextIndex);
    const hoverProvider = new NativeHoverProvider(nativesDb);
    const signatureHelpProvider = new NativeSignatureHelpProvider(nativesDb);
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(LUA_SELECTOR, completionProvider),
      vscode.languages.registerHoverProvider(LUA_SELECTOR, hoverProvider),
      vscode.languages.registerSignatureHelpProvider(LUA_SELECTOR, signatureHelpProvider, '(', ','),
      vscode.languages.registerCodeActionsProvider(LUA_SELECTOR, new NativeQuickFixProvider(), {
        providedCodeActionKinds: NativeQuickFixProvider.providedCodeActionKinds,
      }),
    );
  }

  // --- Imports / exports IntelliSense -----------------------------------------
  if (config.get<boolean>('imports.enable', true)) {
    const exportsCompletionProvider = new ExportsCompletionProvider(exportsIndex);
    const eventCompletionProvider = new EventNameCompletionProvider(exportsIndex);
    const exportsEventsDefinitionProvider = new ExportsEventsDefinitionProvider(exportsIndex);
    const exportsEventsHoverProvider = new ExportsEventsHoverProvider(exportsIndex);
    const importsWorkspaceSymbolProvider = new ImportsWorkspaceSymbolProvider(exportsIndex);
    const importsRenameProvider = new ImportsRenameProvider(contextIndex);
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(LUA_SELECTOR, exportsCompletionProvider, '.', ':'),
      vscode.languages.registerCompletionItemProvider(LUA_SELECTOR, eventCompletionProvider, "'", '"'),
      vscode.languages.registerDefinitionProvider(LUA_SELECTOR, exportsEventsDefinitionProvider),
      vscode.languages.registerHoverProvider(LUA_SELECTOR, exportsEventsHoverProvider),
      vscode.languages.registerWorkspaceSymbolProvider(importsWorkspaceSymbolProvider),
      vscode.languages.registerRenameProvider(LUA_SELECTOR, importsRenameProvider),
    );

    if (config.get<boolean>('imports.enableEventCodeLens', true)) {
      const importsEventCodeLensProvider = new ImportsEventCodeLensProvider(exportsIndex);
      context.subscriptions.push(vscode.languages.registerCodeLensProvider(LUA_SELECTOR, importsEventCodeLensProvider));
    }
  }

  // --- Lightweight local OOP/table-method completion ---------------------------
  if (config.get<boolean>('oop.enable', true)) {
    const tableMethodCompletionProvider = new TableMethodCompletionProvider(
      tableMethodIndexer,
      scanner,
      contextIndex,
      exportsIndex,
    );
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(LUA_SELECTOR, tableMethodCompletionProvider, '.', ':'),
    );
  }

  // --- RCON: restart the owning resource on save --------------------------------
  let rconManager: RconManager | undefined;
  if (config.get<boolean>('rcon.enable', true)) {
    rconManager = new RconManager(context.secrets, scanner, log);
    context.subscriptions.push(rconManager);

    context.subscriptions.push(
      vscode.commands.registerCommand('perfectFivem.rcon.connect', () => rconManager?.connect()),
      vscode.commands.registerCommand('perfectFivem.rcon.connectCustom', () => rconManager?.connectCustom()),
      vscode.commands.registerCommand('perfectFivem.rcon.disconnect', () => rconManager?.disconnect()),
      vscode.commands.registerCommand('perfectFivem.rcon.toggleConnection', () => rconManager?.toggleConnection()),
      vscode.commands.registerCommand('perfectFivem.rcon.forgetPassword', () => rconManager?.forgetPassword()),
      vscode.commands.registerCommand('perfectFivem.rcon.restartCurrentResource', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage('Perfect FiveM: no active editor.');
          return;
        }
        if (!rconManager?.isConnected) {
          vscode.window.showWarningMessage('Perfect FiveM: not connected to RCON.');
          return;
        }
        if (!rconManager.restartForFile(editor.document.uri.fsPath)) {
          vscode.window.showWarningMessage('Perfect FiveM: this file is not part of any detected resource.');
        }
      }),

      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file') return;
        if (!vscode.workspace.getConfiguration('perfectFivem.rcon').get<boolean>('autoRestartOnSave', true)) return;
        if (!rconManager?.isConnected) {
          log.info(`RCON: skipped restart-on-save for '${document.uri.fsPath}' (not connected).`);
          return;
        }
        if (!rconManager.restartForFile(document.uri.fsPath)) {
          log.warn(`RCON: saved '${document.uri.fsPath}' but it isn't part of any detected resource - no restart sent.`);
        }
      }),
    );
  }

  // --- Context refresh on save (require() graph depends on file content, not just presence) ----
  const contextRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId !== 'lua' || document.uri.scheme !== 'file') return;
      const key = normalizePathKey(document.uri.fsPath);
      const existing = contextRefreshTimers.get(key);
      if (existing) clearTimeout(existing);
      contextRefreshTimers.set(
        key,
        setTimeout(() => {
          contextRefreshTimers.delete(key);
          void contextIndex.refreshForFile(document.uri.fsPath);
        }, DIAGNOSTIC_DEBOUNCE_MS),
      );
    }),
  );

  // --- Diagnostics -------------------------------------------------------------
  const diagnostics = new NativeContextDiagnostics(nativesDb, contextIndex);
  context.subscriptions.push(diagnostics);

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleDiagnostics = (document: vscode.TextDocument) => {
    if (document.languageId !== 'lua') return;
    const key = document.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        diagnostics.refresh(document);
      }, DIAGNOSTIC_DEBOUNCE_MS),
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(scheduleDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleDiagnostics(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
    contextIndex.onDidChangeContext((uris) => {
      const changed = new Set(uris.map((u) => normalizePathKey(u.fsPath)));
      for (const doc of vscode.workspace.textDocuments) {
        if (changed.has(normalizePathKey(doc.uri.fsPath))) scheduleDiagnostics(doc);
      }
    }),
  );
  for (const doc of vscode.workspace.textDocuments) scheduleDiagnostics(doc);

  // --- Commands ------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('perfectFivem.rescanWorkspace', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Perfect FiveM: rescanning workspace…' },
        async () => {
          await scanner.initialScan();
          await Promise.all([contextIndex.initialBuild(), exportsIndex.initialBuild(), tableMethodIndexer.initialBuild()]);
        },
      );
      vscode.window.showInformationMessage(`Perfect FiveM: found ${scanner.resources.length} resource(s).`);
    }),

    vscode.commands.registerCommand('perfectFivem.refreshNativesDatabase', async () => {
      await nativesDb.reload();
      vscode.window.showInformationMessage(
        nativesDb.isLoaded
          ? `Perfect FiveM: reloaded ${nativesDb.size} natives.`
          : 'Perfect FiveM: failed to reload natives database, see the "Perfect FiveM" output channel.',
      );
    }),

    vscode.commands.registerCommand('perfectFivem.showResourceInfo', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Perfect FiveM: no active editor.');
        return;
      }
      const entry = contextIndex.getFileContext(editor.document.uri);
      if (!entry) {
        vscode.window.showInformationMessage('Perfect FiveM: this file is not part of any detected resource.');
        return;
      }
      const manifest = contextIndex.getManifest(entry.resource);
      const importLines = (manifest?.imports ?? []).map((i) => `  @${i.resourceName}/${i.path} (${i.declaredIn})`);
      const lines = [
        `Resource: ${entry.resource.name}`,
        `Context: ${entry.context}`,
        `Loaded via: ${
          entry.via === 'require' ? 'require() - not listed in fxmanifest.lua' : 'fxmanifest.lua script pattern'
        }`,
        `Manifest: ${vscode.workspace.asRelativePath(entry.resource.manifestUri)} (${entry.resource.manifestKind})`,
        ...(importLines.length ? ['Declared imports:', ...importLines] : []),
      ];
      vscode.window.showInformationMessage(lines.join('\n'));
      log.info(lines.join(' | '));
    }),
  );

  // Feature toggles are read once at activation; prompt for a reload if they change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const toggles = [
        'decorations.enable',
        'natives.enable',
        'imports.enable',
        'imports.enableEventCodeLens',
        'rcon.enable',
        'oop.enable',
      ];
      if (toggles.some((t) => e.affectsConfiguration(`perfectFivem.${t}`))) {
        vscode.window
          .showInformationMessage('Perfect FiveM: reload the window for this setting to take effect.', 'Reload Window')
          .then((choice) => {
            if (choice === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
      }
    }),
  );
}

export function deactivate(): void {
  // All disposables are owned by context.subscriptions; nothing else to clean up.
}
