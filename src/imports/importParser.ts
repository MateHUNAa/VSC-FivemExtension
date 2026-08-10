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
