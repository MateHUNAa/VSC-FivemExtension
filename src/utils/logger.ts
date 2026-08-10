import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Perfect FiveM');

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[warn] ${message}`);
  }

  error(message: string, err?: unknown): void {
    this.channel.appendLine(`[error] ${message}${err ? `: ${String(err)}` : ''}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
