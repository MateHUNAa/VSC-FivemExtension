/**
 * fxmanifest.lua script patterns use Cfx's own glob dialect: `*` matches within a path
 * segment, `**` matches across segments (and may appear glued to a suffix, e.g. `**.lua`
 * meaning "any .lua file at any depth"), `?` matches a single character. This module only
 * detects whether a pattern needs glob expansion; VS Code's own glob engine is reused for
 * the actual filesystem match (see resolvePatterns in contextIndex.ts).
 */

export function isGlobPattern(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/**
 * Rewrites an fxmanifest glob into a pattern VS Code's minimatch-based glob engine accepts.
 * The only real divergence is `**` not followed by `/`: Cfx treats it as "recurse then match
 * the rest here", VS Code expects an explicit `**/` segment boundary.
 */
export function normalizeFxGlobToVscodeGlob(pattern: string): string {
  let p = pattern.replace(/\\/g, '/').trim();
  p = p.replace(/\*\*(?!\/)/g, '**/*');
  p = p.replace(/\/{2,}/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}
