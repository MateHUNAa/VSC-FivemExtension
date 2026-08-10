import * as vscode from 'vscode';
import { ResourceScanner } from '../core/resourceScanner';
import { Logger } from '../utils/logger';
import { RconClient, RconCredentials } from './rconClient';

const SECRET_KEY = 'perfectFivem.rcon.password';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 30120;

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('perfectFivem.rcon');
}

function configTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/**
 * Owns the RCON connection lifecycle, the status bar indicator, and per-resource restart
 * debouncing. The password is kept in vscode.SecretStorage (OS keychain-backed) rather than
 * workspace state, unlike the original fivem-devbridge implementation this replaces.
 */
export class RconManager implements vscode.Disposable {
  private readonly client = new RconClient();
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastHost = DEFAULT_HOST;
  private lastPort = DEFAULT_PORT;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly scanner: ResourceScanner,
    private readonly log: Logger,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'perfectFivem.rcon.toggleConnection';
    this.updateStatusBar();
    this.statusBarItem.show();

    this.disposables.push(
      this.client,
      this.statusBarItem,
      this.client.onDidChangeState(() => this.updateStatusBar()),
      this.client.onResponse((str) => this.handleResponse(str)),
    );
  }

  get isConnected(): boolean {
    return this.client.state === 'connected';
  }

  private updateStatusBar(): void {
    switch (this.client.state) {
      case 'connected':
        this.statusBarItem.text = '$(plug) FiveM RCON';
        this.statusBarItem.tooltip = `Connected to ${this.lastHost}:${this.lastPort} — click to disconnect`;
        break;
      case 'connecting':
        this.statusBarItem.text = '$(sync~spin) FiveM RCON';
        this.statusBarItem.tooltip = 'Connecting…';
        break;
      case 'error':
        this.statusBarItem.text = '$(error) FiveM RCON';
        this.statusBarItem.tooltip = 'Connection error — click to retry';
        break;
      default:
        this.statusBarItem.text = '$(debug-disconnect) FiveM RCON';
        this.statusBarItem.tooltip = 'Click to connect';
    }
  }

  private handleResponse(str: string): void {
    this.log.info(`RCON: ${str}`);
    if (str.includes("Couldn't find resource")) {
      vscode.window.showErrorMessage("Perfect FiveM: server reported it couldn't find the resource.");
    } else if (/invalid.*password/i.test(str)) {
      vscode.window.showErrorMessage('Perfect FiveM: RCON authentication failed (invalid password). Use "Perfect FiveM: RCON Forget Saved Password" and reconnect.');
    } else if (str.startsWith('error:')) {
      vscode.window.showErrorMessage(`Perfect FiveM: RCON ${str}`);
    }
  }

  /** Connects using the configured host/port, reusing the saved password if present or prompting (and saving) otherwise. */
  async connect(): Promise<void> {
    if (this.isConnected || this.client.state === 'connecting') {
      vscode.window.showWarningMessage('Perfect FiveM: already connected (or connecting) to RCON. Disconnect first.');
      return;
    }
    const config = getConfig();
    const host = config.get<string>('host', DEFAULT_HOST);
    const port = config.get<number>('port', DEFAULT_PORT);

    let password = await this.secrets.get(SECRET_KEY);
    if (!password) {
      const input = await vscode.window.showInputBox({
        placeHolder: 'password',
        password: true,
        prompt: `RCON password for ${host}:${port}`,
      });
      if (!input) {
        vscode.window.showErrorMessage('Perfect FiveM: no RCON password provided.');
        return;
      }
      password = input;
      await this.secrets.store(SECRET_KEY, password);
    }

    this.doConnect({ host, port, password });
  }

  /** Prompts for a fresh host:port + password, persists them, and connects. */
  async connectCustom(): Promise<void> {
    if (this.isConnected || this.client.state === 'connecting') {
      vscode.window.showWarningMessage('Perfect FiveM: already connected (or connecting) to RCON. Disconnect first.');
      return;
    }
    const details = await vscode.window.showInputBox({ placeHolder: 'ip:port', prompt: 'Server IP and RCON port' });
    if (!details) return;
    const [host, portStr] = details.split(':');
    const port = Number(portStr);
    if (!host || !Number.isFinite(port)) {
      vscode.window.showErrorMessage('Perfect FiveM: invalid ip:port.');
      return;
    }
    const password = await vscode.window.showInputBox({ placeHolder: 'password', password: true, prompt: 'RCON password' });
    if (!password) {
      vscode.window.showErrorMessage('Perfect FiveM: no RCON password provided.');
      return;
    }

    await this.secrets.store(SECRET_KEY, password);
    const target = configTarget();
    await getConfig().update('host', host, target);
    await getConfig().update('port', port, target);

    this.doConnect({ host, port, password });
  }

  private doConnect(creds: RconCredentials): void {
    this.lastHost = creds.host;
    this.lastPort = creds.port;
    this.client.connect(creds);
  }

  disconnect(): void {
    this.client.disconnect();
  }

  toggleConnection(): void {
    if (this.isConnected || this.client.state === 'connecting') {
      this.disconnect();
    } else {
      void this.connect();
    }
  }

  async forgetPassword(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Perfect FiveM: saved RCON password cleared.');
  }

  /** Sends `refresh; ensure <resourceName>`, debounced per resource so rapid/bulk saves coalesce into a single restart. */
  scheduleRestart(resourceName: string): void {
    if (!this.isConnected) return;
    const delay = getConfig().get<number>('restartDelayMs', 300);
    const existing = this.restartTimers.get(resourceName);
    if (existing) clearTimeout(existing);
    this.restartTimers.set(
      resourceName,
      setTimeout(() => {
        this.restartTimers.delete(resourceName);
        void this.sendRestart(resourceName);
      }, Math.max(0, delay)),
    );
  }

  private async sendRestart(resourceName: string): Promise<void> {
    this.log.info(`RCON: sending restart for resource '${resourceName}'…`);
    try {
      // Waiting for a reply (instead of firing-and-forgetting) is what actually proves the
      // command reached the server - UDP gives no other delivery guarantee. A real response is
      // already logged/pattern-matched by handleResponse via the persistent onResponse event.
      const response = await this.client.sendAndWait(`refresh; ensure ${resourceName}`);
      if (response === undefined) {
        this.log.warn(
          `RCON: sent restart for '${resourceName}' but got no response - verify host/port/password, and that the server is actually running and reachable.`,
        );
      }
    } catch (err) {
      this.log.error(`RCON: failed to restart '${resourceName}'`, err);
    }
  }

  /** Restarts the resource that owns `fsPath`, if any. Returns whether a restart was scheduled. */
  restartForFile(fsPath: string): boolean {
    const resource = this.scanner.getResourceForFile(fsPath);
    if (!resource) return false;
    this.scheduleRestart(resource.name);
    return true;
  }

  dispose(): void {
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
