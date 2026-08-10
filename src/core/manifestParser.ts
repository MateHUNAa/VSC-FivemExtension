import { ImportReference, ParsedManifest, ScriptContext } from './types';

const SCRIPT_KEYS: Record<string, ScriptContext> = {
  client_script: 'client',
  client_scripts: 'client',
  server_script: 'server',
  server_scripts: 'server',
  shared_script: 'shared',
  shared_scripts: 'shared',
};

/** Strips `--[[ ... ]]` / `--[=[ ... ]=]` long comments and `-- ...` line comments. */
export function stripComments(text: string): string {
  // Long comments: --[[ ... ]], --[=[ ... ]=], etc. Must run before line-comment stripping.
  let out = text.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (m) => blank(m));

  // Line comments, but quote-aware so `--` inside a string literal survives.
  let result = '';
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < out.length) {
    const c = out[i];
    if (quote) {
      result += c;
      if (c === '\\' && i + 1 < out.length) {
        result += out[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      result += c;
      i++;
      continue;
    }
    if (c === '-' && out[i + 1] === '-') {
      const nl = out.indexOf('\n', i);
      if (nl === -1) {
        i = out.length;
        break;
      }
      result += '\n'; // drop the comment text but keep the newline
      i = nl + 1;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

/** Replaces a matched span with whitespace of the same length (preserves line/col offsets, and newlines). */
function blank(span: string): string {
  return span.replace(/[^\n]/g, ' ');
}

interface ScanResult {
  strings: string[];
  nextIndex: number;
}

/** Parses either a quoted string literal or a `{ ... }` table of string literals starting at `index`. */
function scanValue(text: string, index: number): ScanResult | undefined {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '(') {
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  if (text[i] === '"' || text[i] === "'") {
    const [str, end] = scanString(text, i);
    return { strings: [str], nextIndex: end };
  }
  if (text[i] === '{') {
    const strings: string[] = [];
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      } else if (c === '"' || c === "'") {
        const [str, end] = scanString(text, j);
        strings.push(str);
        j = end - 1; // for-loop will increment
      }
    }
    return { strings, nextIndex: j };
  }
  return undefined;
}

function scanString(text: string, index: number): [string, number] {
  const quote = text[index];
  let i = index + 1;
  let out = '';
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\' && i + 1 < text.length) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return [out, i + 1];
}

export function parseManifest(text: string, resourceName: string): ParsedManifest {
  const manifest: ParsedManifest = {
    resourceName,
    clientPatterns: [],
    serverPatterns: [],
    sharedPatterns: [],
    imports: [],
    malformed: false,
    errors: [],
  };

  let clean: string;
  try {
    clean = stripComments(text);
  } catch (err) {
    manifest.malformed = true;
    manifest.errors.push(`Failed to strip comments: ${String(err)}`);
    return manifest;
  }

  const keyRe = /\b(client_scripts?|server_scripts?|shared_scripts?)\b/g;
  let match: RegExpExecArray | null;
  try {
    while ((match = keyRe.exec(clean))) {
      const key = match[1];
      const context = SCRIPT_KEYS[key];
      const value = scanValue(clean, keyRe.lastIndex);
      if (!value) {
        manifest.errors.push(`Could not parse value for '${key}' near offset ${match.index}`);
        continue;
      }
      keyRe.lastIndex = value.nextIndex;
      for (const raw of value.strings) {
        if (raw.startsWith('@')) {
          const ref = parseImportString(raw, context);
          if (ref) manifest.imports.push(ref);
          continue;
        }
        pushPattern(manifest, context, raw);
      }
    }
  } catch (err) {
    manifest.malformed = true;
    manifest.errors.push(`Parse error: ${String(err)}`);
  }

  return manifest;
}

function pushPattern(manifest: ParsedManifest, context: ScriptContext, pattern: string) {
  if (context === 'client') manifest.clientPatterns.push(pattern);
  else if (context === 'server') manifest.serverPatterns.push(pattern);
  else manifest.sharedPatterns.push(pattern);
}

export function parseImportString(raw: string, declaredIn: ScriptContext): ImportReference | undefined {
  const m = /^@([^/]+)\/(.+)$/.exec(raw);
  if (!m) return undefined;
  return { raw, resourceName: m[1], path: m[2], declaredIn };
}
