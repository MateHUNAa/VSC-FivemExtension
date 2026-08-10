import * as vscode from 'vscode';
// The `rcon` package has no bundled types; see src/types/rcon.d.ts for the minimal ambient declaration.
import Rcon = require('rcon');

export type RconConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RconCredentials {
  host: string;
  port: number;
  password: string;
}

/**
 * Thin wrapper around the `rcon` package configured for FiveM's RCON dialect (UDP, no
 * challenge handshake - `{ tcp: false, challenge: false }`), matching what fivem-devbridge
 * used. Exposes connection state and server responses as vscode events instead of raw
 * EventEmitter listeners.
 */
export class RconClient implements vscode.Disposable {
  private connection: Rcon | undefined;
  private _state: RconConnectionState = 'disconnected';

  private readonly _onDidChangeState = new vscode.EventEmitter<RconConnectionState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private readonly _onResponse = new vscode.EventEmitter<string>();
  readonly onResponse = this._onResponse.event;

  get state(): RconConnectionState {
    return this._state;
  }

  connect(creds: RconCredentials): void {
    this.disconnect();
    this.setState('connecting');

    const connection = new Rcon(creds.host, creds.port, creds.password, { tcp: false, challenge: false });
    connection
      .on('auth', () => this.setState('connected'))
      .on('response', (str: string) => this._onResponse.fire(str))
      .on('error', (err: unknown) => {
        this.setState('error');
        this._onResponse.fire(`error: ${String(err)}`);
      })
      .on('end', () => this.setState('disconnected'));

    this.connection = connection;
    connection.connect();
  }

  disconnect(): void {
    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch {
        // socket may already be closed; nothing to do
      }
      this.connection = undefined;
    }
    if (this._state !== 'disconnected') this.setState('disconnected');
  }

  send(command: string): void {
    if (this._state !== 'connected' || !this.connection) {
      throw new Error('Not connected to an RCON server.');
    }
    this.connection.send(command);
  }

  private setState(state: RconConnectionState): void {
    this._state = state;
    this._onDidChangeState.fire(state);
  }

  dispose(): void {
    this.disconnect();
    this._onDidChangeState.dispose();
    this._onResponse.dispose();
  }
}
