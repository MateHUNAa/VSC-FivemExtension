export interface ExportsAccessContext {
  resourceName: string;
  style: 'bracket' | 'dot';
}

/** Detects `exports['resource']:` or `exports.resource.` / `exports.resource:` right before the cursor. */
export function detectExportsAccess(linePrefix: string): ExportsAccessContext | undefined {
  let m = /exports\[['"]([\w-]+)['"]\]\s*:\s*$/.exec(linePrefix);
  if (m) return { resourceName: m[1], style: 'bracket' };

  m = /exports\.([\w-]+)\s*[:.]\s*$/.exec(linePrefix);
  if (m) return { resourceName: m[1], style: 'dot' };

  return undefined;
}

const EVENT_CALL_TRIGGER_RE = /\b(?:TriggerEvent|TriggerServerEvent|TriggerClientEvent|RegisterNetEvent|AddEventHandler)\s*\(\s*['"][^'"]*$/;

/** Detects being inside the (still-open) string literal that is the first argument of an event call. */
export function isInsideEventCallArgument(linePrefix: string): boolean {
  return EVENT_CALL_TRIGGER_RE.test(linePrefix);
}

export interface RangeOffsets {
  start: number;
  end: number;
}

export interface ExportsCallSiteMatch {
  resourceName: string;
  methodName: string;
  methodRange: RangeOffsets;
}

export interface ExportDeclarationMatch {
  methodName: string;
  methodRange: RangeOffsets;
}

export interface EventLiteralMatch {
  eventName: string;
  nameRange: RangeOffsets;
  /** Which call form the cursor is on: 'register' for RegisterNetEvent/AddEventHandler (the
   * handler side), 'trigger' for TriggerEvent/TriggerServerEvent/etc (the caller side). */
  callKind: 'register' | 'trigger';
}

// Same access forms as detectExportsAccess above, but matched anywhere on the line (not just
// as a still-typing prefix) and capturing the method name's own range so a cursor position can
// be tested against it - used by go-to-definition/hover/rename, which trigger mid-identifier.
const EXPORTS_BRACKET_CALL_RE = /exports\[['"]([\w-]+)['"]\]\s*:\s*([A-Za-z_]\w*)/g;
const EXPORTS_DOT_CALL_RE = /exports\.([\w-]+)\s*[:.]\s*([A-Za-z_]\w*)/g;

/** Finds an `exports['resource']:method`/`exports.resource:method`/`exports.resource.method` call
 * whose method-name token contains `character`, anywhere on `lineText`. */
export function findExportsCallAt(lineText: string, character: number): ExportsCallSiteMatch | undefined {
  for (const re of [EXPORTS_BRACKET_CALL_RE, EXPORTS_DOT_CALL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText))) {
      // The method name is always the last captured token, immediately followed by nothing else
      // consumed by the pattern, so its end offset is exactly the match's end offset.
      const end = m.index + m[0].length;
      const start = end - m[2].length;
      if (character >= start && character <= end) {
        return { resourceName: m[1], methodName: m[2], methodRange: { start, end } };
      }
    }
  }
  return undefined;
}

const EXPORT_CALL_DECL_RE = /exports\s*\(\s*['"]([A-Za-z_]\w*)['"]/g;
const EXPORT_ASSIGN_DECL_RE = /exports\.([A-Za-z_]\w*)\s*=\s*function/g;

/** Finds an `exports('name', function...)` / `exports.name = function` declaration whose name
 * token contains `character`, anywhere on `lineText`. */
export function findExportDeclarationAt(lineText: string, character: number): ExportDeclarationMatch | undefined {
  EXPORT_CALL_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_CALL_DECL_RE.exec(lineText))) {
    // Name is followed by exactly one closing quote before the match ends.
    const end = m.index + m[0].length - 1;
    const start = end - m[1].length;
    if (character >= start && character <= end) return { methodName: m[1], methodRange: { start, end } };
  }

  EXPORT_ASSIGN_DECL_RE.lastIndex = 0;
  while ((m = EXPORT_ASSIGN_DECL_RE.exec(lineText))) {
    // Name sits right after the fixed-length "exports." prefix.
    const start = m.index + 'exports.'.length;
    const end = start + m[1].length;
    if (character >= start && character <= end) return { methodName: m[1], methodRange: { start, end } };
  }

  return undefined;
}

const REGISTER_FUNCTIONS = new Set(['RegisterNetEvent', 'AddEventHandler']);
const EVENT_LITERAL_RE =
  /\b(RegisterNetEvent|AddEventHandler|TriggerEvent|TriggerServerEvent|TriggerClientEvent|TriggerLatentServerEvent|TriggerLatentClientEvent)\s*\(\s*['"]([^'"]*)['"]/g;

/** Finds the event-name string literal (in any Register/Trigger/AddEventHandler call) containing
 * `character`, anywhere on `lineText`. */
export function findEventLiteralAt(lineText: string, character: number): EventLiteralMatch | undefined {
  EVENT_LITERAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EVENT_LITERAL_RE.exec(lineText))) {
    // Name is followed by exactly one closing quote before the match ends.
    const end = m.index + m[0].length - 1;
    const start = end - m[2].length;
    if (character >= start && character <= end) {
      const callKind = REGISTER_FUNCTIONS.has(m[1]) ? 'register' : 'trigger';
      return { eventName: m[2], nameRange: { start, end }, callKind };
    }
  }
  return undefined;
}
