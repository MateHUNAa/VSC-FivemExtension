import * as path from 'path';

const isWindows = process.platform === 'win32';

/**
 * Normalizes an fsPath for use as a Map key. Windows filesystems are case-insensitive, but
 * VS Code doesn't guarantee consistent drive-letter/segment casing between URIs coming from
 * different APIs (e.g. `workspace.findFiles()` results vs. an open `TextDocument`'s uri) - two
 * URIs that point at the same file can compare unequal as raw strings. Without this, resource
 * lookups (decorations, native context, RCON restart-on-save, ...) can silently miss.
 */
export function normalizePathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return isWindows ? normalized.toLowerCase() : normalized;
}
