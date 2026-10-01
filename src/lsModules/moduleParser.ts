import { docBlockAbove, maskComments, offsetToLine, splitParams } from './luaLexer';

/** A `LS:RegisterModule(name, resource, path?)` call. */
export interface ModuleRegistration {
  moduleName: string;
  /** Target resource name, or undefined when it is the calling resource (`cache.resource`, ...). */
  resourceName: string | undefined;
  /** Path inside the target resource, '' when omitted (loader falls back to `<ctx>/main.lua` etc.). */
  path: string;
  line: number;
}

export interface ModuleMember {
  name: string;
  kind: 'function' | 'field';
  /** ':' for `function T:M()` / forwarded `function(_, ...)`, '.' otherwise. */
  separator: ':' | '.';
  params: string[];
  doc: string[];
  line: number;
}

/** `for _, n in ipairs(list) do T[n] = function(_, ...) return exports.res[n](nil, ...) end end` */
export interface ExportForward {
  exportNames: string[];
  resourceName: string;
  separator: ':' | '.';
  line: number;
}

/** `for alias, n in pairs(aliases) do T[alias] = T[n] end` */
export interface MemberAlias {
  alias: string;
  target: string;
  line: number;
}

export interface ModuleFileSurface {
  members: ModuleMember[];
  forwards: ExportForward[];
  aliases: MemberAlias[];
}

const IDENT = '[A-Za-z_][\\w]*';
const REGISTER_RE = new RegExp(
  `\\bLS\\s*:\\s*RegisterModule\\s*\\(\\s*(['"])(${IDENT})\\1\\s*,\\s*([^,)]+?)\\s*(?:,\\s*(['"])([^'"]*)\\4\\s*)?\\)`,
  'g',
);
const STRING_LITERAL_RE = /^(['"])([^'"]+)\1$/;
const RETURN_RE = new RegExp(`^return\\s+(${IDENT})\\s*;?\\s*$`, 'gm');

export function parseRegistrations(text: string): ModuleRegistration[] {
  const masked = maskComments(text);
  const out: ModuleRegistration[] = [];
  let m: RegExpExecArray | null;
  REGISTER_RE.lastIndex = 0;
  while ((m = REGISTER_RE.exec(masked))) {
    const literal = STRING_LITERAL_RE.exec(m[3].trim());
    out.push({
      moduleName: m[2],
      // cache.resource, GetCurrentResourceName(), a local holding either - all mean "this resource".
      resourceName: literal ? literal[2] : undefined,
      path: (m[5] ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      line: offsetToLine(masked, m.index),
    });
  }
  return out;
}

/** Name of the table a module chunk hands back: the last column-0 `return Ident`. */
export function findReturnedTable(text: string): string | undefined {
  const masked = maskComments(text);
  let name: string | undefined;
  let m: RegExpExecArray | null;
  RETURN_RE.lastIndex = 0;
  while ((m = RETURN_RE.exec(masked))) name = m[1];
  return name;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringList(masked: string, listName: string): string[] | undefined {
  const re = new RegExp(`\\blocal\\s+${escape(listName)}\\s*(?:<const>\\s*)?=\\s*\\{([\\s\\S]*?)\\}`);
  const m = re.exec(masked);
  if (!m) return undefined;
  return [...m[1].matchAll(/(['"])([^'"]+)\1/g)].map((s) => s[2]);
}

function stringMap(masked: string, mapName: string): [string, string][] | undefined {
  const re = new RegExp(`\\blocal\\s+${escape(mapName)}\\s*(?:<const>\\s*)?=\\s*\\{([\\s\\S]*?)\\}`);
  const m = re.exec(masked);
  if (!m) return undefined;
  const pairs: [string, string][] = [];
  for (const p of m[1].matchAll(/(?:\[\s*(['"])([^'"]+)\1\s*\]|([A-Za-z_]\w*))\s*=\s*(['"])([^'"]+)\4/g)) {
    pairs.push([p[2] ?? p[3], p[5]]);
  }
  return pairs;
}

/** Collects everything a module file puts on `tableName`. */
export function parseModuleFile(text: string, tableName: string): ModuleFileSurface {
  const masked = maskComments(text);
  const lines = text.split(/\r?\n/);
  const t = escape(tableName);
  const members = new Map<string, ModuleMember>();

  const add = (member: ModuleMember) => {
    const existing = members.get(member.name);
    // A later function definition wins over an earlier placeholder field (`T.M = nil` then `function T:M`).
    if (!existing || (existing.kind === 'field' && member.kind === 'function')) members.set(member.name, member);
  };

  const fnDecl = new RegExp(`^[ \\t]*function\\s+${t}\\s*([.:])\\s*(${IDENT})\\s*\\(([^)]*)\\)`, 'gm');
  for (const m of masked.matchAll(fnDecl)) {
    const line = offsetToLine(masked, m.index!);
    add({
      name: m[2],
      kind: 'function',
      separator: m[1] as ':' | '.',
      params: splitParams(m[3]),
      doc: docBlockAbove(lines, line),
      line,
    });
  }

  const fnAssign = new RegExp(`^[ \\t]*${t}\\s*\\.\\s*(${IDENT})\\s*=\\s*function\\s*\\(([^)]*)\\)`, 'gm');
  for (const m of masked.matchAll(fnAssign)) {
    const line = offsetToLine(masked, m.index!);
    add({ name: m[1], kind: 'function', separator: '.', params: splitParams(m[2]), doc: docBlockAbove(lines, line), line });
  }

  const fieldAssign = new RegExp(`^[ \\t]*${t}\\s*\\.\\s*(${IDENT})\\s*=(?!=)\\s*(?!function\\b)\\S`, 'gm');
  for (const m of masked.matchAll(fieldAssign)) {
    const line = offsetToLine(masked, m.index!);
    add({ name: m[1], kind: 'field', separator: '.', params: [], doc: docBlockAbove(lines, line), line });
  }

  const forwards: ExportForward[] = [];
  const forwardLoop = new RegExp(
    `\\bfor\\s+${IDENT}\\s*,\\s*(${IDENT})\\s+in\\s+ipairs\\s*\\(\\s*(${IDENT})\\s*\\)\\s*do\\s+${t}\\s*\\[\\s*\\1\\s*\\]\\s*=\\s*function\\s*\\(([^)]*)\\)([\\s\\S]*?)\\bend\\b`,
    'g',
  );
  for (const m of masked.matchAll(forwardLoop)) {
    const v = escape(m[1]);
    const target = new RegExp(`\\bexports\\s*(?:\\.\\s*(${IDENT})|\\[\\s*(['"])([^'"]+)\\2\\s*\\])\\s*\\[\\s*${v}\\s*\\]`).exec(m[4]);
    const names = target && stringList(masked, m[2]);
    if (!target || !names) continue;
    const firstParam = splitParams(m[3])[0];
    forwards.push({
      exportNames: names,
      resourceName: target[1] ?? target[3],
      separator: firstParam === '_' || firstParam === 'self' ? ':' : '.',
      line: offsetToLine(masked, m.index!),
    });
  }

  const aliases: MemberAlias[] = [];
  const aliasLoop = new RegExp(
    `\\bfor\\s+(${IDENT})\\s*,\\s*(${IDENT})\\s+in\\s+pairs\\s*\\(\\s*(${IDENT})\\s*\\)\\s*do\\s+${t}\\s*\\[\\s*\\1\\s*\\]\\s*=\\s*${t}\\s*\\[\\s*\\2\\s*\\]`,
    'g',
  );
  for (const m of masked.matchAll(aliasLoop)) {
    const line = offsetToLine(masked, m.index!);
    for (const [alias, target] of stringMap(masked, m[3]) ?? []) aliases.push({ alias, target, line });
  }

  return { members: [...members.values()], forwards, aliases };
}

/** Candidate files the ls_core loader (`init.lua` loadModule) tries, in order, for one side. */
export function moduleFileCandidates(dir: string, side: 'client' | 'server'): { context: string[]; shared: string[] } {
  const prefix = dir ? `${dir}/` : '';
  return {
    context: [`${prefix}${side}.lua`, `${prefix}${side}/init.lua`, `${prefix}${side}/main.lua`, `${side}/${side}.lua`, `${side}/main.lua`],
    shared: [`${prefix}shared.lua`, `${prefix}shared/init.lua`, `${prefix}shared/main.lua`, 'shared/init.lua', 'shared/main.lua'],
  };
}
