import * as dgram from 'dgram';
import * as vscode from 'vscode';
import { decodeRconMessage, encodeRconRequest } from './protocol';

export type RconConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RconCredentials {
  host: string;
  port: number;
  password: string;
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 2000;

/**
 * Native UDP implementation of FiveM's RCON dialect (see protocol.ts) using Node's built-in
 * `dgram` module - no external dependency. UDP has no real "connection", so `connect()` just
 * opens a local socket; `sendAndWait()` is what actually proves the server is reachable and
 * the password is correct, by racing the next incoming "print" packet against a timeout.
 */
export class RconClient implements vscode.Disposable {
  private socket: dgram.Socket | undefined;
  private creds: RconCredentials | undefined;
  private _state: RconConnectionState = 'disconnected';

  private readonly _onDidChangeState = new vscode.EventEmitter<RconConnectionState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  /** Fires the decoded text of every "print" packet received, regardless of which send() triggered it. */
  private readonly _onResponse = new vscode.EventEmitter<string>();
  readonly onResponse = this._onResponse.event;

  get state(): RconConnectionState {
    return this._state;
  }

  connect(creds: RconCredentials): void {
    this.disconnect();
    this.setState('connecting');
    this.creds = creds;

    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
      this.setState('error');
      this._onResponse.fire(`error: ${String(err)}`);
    });
    socket.on('message', (msg) => {
      const decoded = decodeRconMessage(msg);
      if (decoded && decoded.name.toLowerCase() === 'print') {
        this._onResponse.fire(decoded.data);
      }
    });

    this.socket = socket;
    // UDP is connectionless - there's no handshake to wait on, so report "connected" as soon
    // as the local socket is ready. Real reachability/auth is only proven by an actual
    // round trip; see sendAndWait().
    this.setState('connected');
  }

  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // socket may already be closed; nothing to do
      }
      this.socket = undefined;
    }
    this.creds = undefined;
    if (this._state !== 'disconnected') this.setState('disconnected');
  }

  /** Fire-and-forget send; the response (if any) surfaces asynchronously via onResponse. */
  send(command: string): void {
    if (this._state !== 'connected' || !this.socket || !this.creds) {
      throw new Error('Not connected to an RCON server.');
    }
    const packet = encodeRconRequest(this.creds.password, command);
    this.socket.send(packet, this.creds.port, this.creds.host);
  }

  /**
   * Sends a command and resolves with the next "print" response's text, or `undefined` if
   * none arrives within `timeoutMs`. The protocol has no request/response correlation IDs, so
   * this assumes at most one command is in flight at a time - true for how RconManager uses it.
   */
  sendAndWait(command: string, timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sub.dispose();
        resolve(undefined);
      }, timeoutMs);
      const sub = this.onResponse((text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.dispose();
        resolve(text);
      });

      try {
        this.send(command);
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          sub.dispose();
          resolve(undefined);
        }
      }
    });
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
