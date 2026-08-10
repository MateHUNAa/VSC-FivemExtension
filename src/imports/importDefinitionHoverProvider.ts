import * as vscode from 'vscode';
import { EventEntry } from '../core/types';
import { ExportsIndexer } from './exportsIndexer';
import { findEventLiteralAt, findExportsCallAt } from './importParser';

/** Standing on a RegisterNetEvent/AddEventHandler call, "opposite" means the TriggerEvent-family
 * call sites that fire it (and vice versa) - the two sides of an event always link to each other. */
function oppositeEntries(exportsIndex: ExportsIndexer, name: string, callKind: 'register' | 'trigger'): EventEntry[] {
  const wantKind = callKind === 'register' ? 'trigger' : 'register';
  return exportsIndex.getAllEvents().filter((e) => e.name === name && e.kind === wantKind);
}

/** Go-to-definition for `exports['resource']:method()` call sites (jumps to the resource's
 * `exports(...)` declaration) and for event-name string literals: standing on a
 * TriggerEvent-family call jumps to every `RegisterNetEvent`/`AddEventHandler` that handles it;
 * standing on a `RegisterNetEvent`/`AddEventHandler` jumps to every call site that triggers it. */
export class ExportsEventsDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly exportsIndex: ExportsIndexer) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const lineText = document.lineAt(position.line).text;
    const character = position.character;

    const callSite = findExportsCallAt(lineText, character);
    if (callSite) {
      const entry = this.exportsIndex.getExports(callSite.resourceName).find((e) => e.name === callSite.methodName);
      if (!entry) return undefined;
      return new vscode.Location(entry.fileUri, new vscode.Position(entry.line, 0));
    }

    const eventSite = findEventLiteralAt(lineText, character);
    if (eventSite) {
      const entries = oppositeEntries(this.exportsIndex, eventSite.eventName, eventSite.callKind);
      if (!entries.length) return undefined;
      return entries.map((e) => new vscode.Location(e.fileUri, new vscode.Position(e.line, 0)));
    }

    return undefined;
  }
}

/** Hover docs for the same two targets as ExportsEventsDefinitionProvider: an export's signature
 * + defining file, or the list of handlers/callers on the opposite side of a given event. */
export class ExportsEventsHoverProvider implements vscode.HoverProvider {
  constructor(private readonly exportsIndex: ExportsIndexer) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const lineText = document.lineAt(position.line).text;
    const character = position.character;

    const callSite = findExportsCallAt(lineText, character);
    if (callSite) {
      const entry = this.exportsIndex.getExports(callSite.resourceName).find((e) => e.name === callSite.methodName);
      if (!entry) return undefined;
      const range = new vscode.Range(position.line, callSite.methodRange.start, position.line, callSite.methodRange.end);
      const md = new vscode.MarkdownString(
        `\`\`\`lua\n${entry.name}(${entry.params.join(', ')})\n\`\`\`\n\n${callSite.resourceName} export — defined in ${vscode.workspace.asRelativePath(entry.fileUri)}:${entry.line + 1}`,
      );
      return new vscode.Hover(md, range);
    }

    const eventSite = findEventLiteralAt(lineText, character);
    if (eventSite) {
      const entries = oppositeEntries(this.exportsIndex, eventSite.eventName, eventSite.callKind);
      if (!entries.length) return undefined;
      const range = new vscode.Range(position.line, eventSite.nameRange.start, position.line, eventSite.nameRange.end);
      const list = entries
        .map((e) => `- **${e.resourceName}** — ${vscode.workspace.asRelativePath(e.fileUri)}:${e.line + 1}`)
        .join('\n');
      const heading = eventSite.callKind === 'register' ? 'Triggered by' : 'Handled by';
      const md = new vscode.MarkdownString(`**FiveM event** \`${eventSite.eventName}\`\n\n${heading}:\n${list}`);
      return new vscode.Hover(md, range);
    }

    return undefined;
  }
}
