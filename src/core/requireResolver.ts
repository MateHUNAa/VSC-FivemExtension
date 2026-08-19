import * as vscode from 'vscode';
import { normalizePathKey } from '../utils/paths';
import { stripComments } from './manifestParser';
import { mergeContext } from './scriptContext';
import { ResourceRoot, ScriptContext } from './types';

// `require('a.b.c')`, `require("a.b.c")`, `require 'a.b.c'`, `require "a.b.c"` - parens optional.
const REQUIRE_RE = /\brequire\s*\(?\s*(['"])([^'"]+)\1/g;

/** Converts a require() spec into a resource-relative .lua path. `@resource/...` cross-resource
 * requires aren't resolved (yet) - only the same-resource dotted/slashed module convention is. */
function specToRelativePath(spec: string): string | undefined {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith('@')) return undefined;
  const rel = trimmed.includes('/') ? trimmed : trimmed.split('.').join('/');
  return rel.toLowerCase().endsWith('.lua') ? rel : `${rel}.lua`;
}

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Resolves every `require(...)` call in a file's text to an existing file within `root`. */
async function extractRequireTargets(root: ResourceRoot, fsPath: string): Promise<string[]> {
  const text = await readFile(vscode.Uri.file(fsPath));
  if (text === undefined) return [];

  let clean: string;
  try {
    clean = stripComments(text);
  } catch {
    clean = text;
  }

  const targets: string[] = [];
  REQUIRE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REQUIRE_RE.exec(clean))) {
    const relPath = specToRelativePath(match[2]);
    if (!relPath) continue;
    const candidateUri = vscode.Uri.joinPath(root.uri, relPath);
    if (!(await fileExists(candidateUri))) continue;
    targets.push(normalizePathKey(candidateUri.fsPath));
  }
  return targets;
}

/**
 * Starting from the manifest-declared entry scripts, follows `require(...)` calls to find Lua
 * files that are loaded transitively but never listed directly in fxmanifest.lua. Runs in two
 * passes: first discovers the require graph (context-independent), then propagates script
 * context outward from the entry points as a monotonic worklist (a file reachable from both
 * client and server converges to `shared`, same as direct manifest patterns).
 *
 * `requiresOf` is a persistent per-resource cache (fsPath -> its resolved require targets),
 * mutated in place and reused across calls: a file already in the cache is only re-scanned (its
 * targets re-extracted) if it's listed in `staleFiles`. This lets a single-file save (the common
 * case) skip re-reading every other file in the resource's require graph - only the saved file's
 * own targets can have changed. Pass a fresh empty map and leave `staleFiles` undefined for a
 * full rebuild (e.g. after a file add/delete or manifest change, when set membership itself may
 * have changed).
 */
export async function resolveRequiredFiles(
  root: ResourceRoot,
  directFiles: Map<string, ScriptContext>, // key: normalized fsPath, from manifest script patterns
  requiresOf: Map<string, string[]>, // fsPath -> resolved require target fsPaths; cache, mutated in place
  staleFiles?: ReadonlySet<string>, // files to force-rescan even if already cached
): Promise<Map<string, ScriptContext>> {
  const allFiles = new Set(directFiles.keys());
  const toScan = [...directFiles.keys()];
  const scanned = new Set<string>();

  while (toScan.length) {
    const fsPath = toScan.pop()!;
    if (scanned.has(fsPath)) continue;
    scanned.add(fsPath);

    const cached = requiresOf.get(fsPath);
    const targets = cached && !staleFiles?.has(fsPath) ? cached : await extractRequireTargets(root, fsPath);
    requiresOf.set(fsPath, targets);
    for (const target of targets) {
      allFiles.add(target);
      if (!scanned.has(target)) toScan.push(target);
    }
  }

  const contextOf = new Map<string, ScriptContext>(directFiles);
  const queue = [...directFiles.keys()];
  while (queue.length) {
    const fsPath = queue.shift()!;
    const context = contextOf.get(fsPath)!;
    for (const target of requiresOf.get(fsPath) ?? []) {
      const existing = contextOf.get(target);
      const merged = existing ? mergeContext(existing, context) : context;
      if (merged !== existing) {
        contextOf.set(target, merged);
        queue.push(target);
      }
    }
  }

  const required = new Map<string, ScriptContext>();
  for (const fsPath of allFiles) {
    if (directFiles.has(fsPath)) continue;
    const context = contextOf.get(fsPath);
    if (context) required.set(fsPath, context);
  }
  return required;
}
