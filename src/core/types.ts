import * as vscode from 'vscode';

/** The three script contexts a Lua file inside a FiveM resource can run in. */
export type ScriptContext = 'client' | 'server' | 'shared';

export type ManifestKind = 'fxmanifest' | 'legacy';

export interface ResourceRoot {
  /** Folder containing the manifest file. */
  uri: vscode.Uri;
  /** Folder name, used as the resource name for exports/imports resolution. */
  name: string;
  manifestUri: vscode.Uri;
  manifestKind: ManifestKind;
}

/** A single `@resource/path` reference found inside a script array. */
export interface ImportReference {
  raw: string;
  resourceName: string;
  path: string;
  declaredIn: ScriptContext;
}

export interface ParsedManifest {
  resourceName: string;
  clientPatterns: string[];
  serverPatterns: string[];
  sharedPatterns: string[];
  imports: ImportReference[];
  malformed: boolean;
  errors: string[];
}

/** How a file ended up assigned to a script context: declared directly in fxmanifest.lua's
 * script arrays, or only reachable by following `require(...)` calls from a declared script. */
export type ContextSource = 'manifest' | 'require';

export interface FileContextEntry {
  context: ScriptContext;
  resource: ResourceRoot;
  via: ContextSource;
}

export interface ExportEntry {
  name: string;
  params: string[];
  resourceName: string;
  fileUri: vscode.Uri;
  line: number;
}

export interface EventEntry {
  name: string;
  resourceName: string;
  fileUri: vscode.Uri;
  line: number;
  kind: 'register' | 'trigger';
}
