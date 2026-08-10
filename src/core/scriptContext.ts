import { ScriptContext } from './types';

/** A file reachable from both client and server is effectively shared. */
export function mergeContext(existing: ScriptContext, incoming: ScriptContext): ScriptContext {
  if (existing === incoming) return existing;
  return 'shared';
}
