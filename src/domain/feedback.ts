import { createHash } from 'node:crypto';
import type { Snapshot } from './types.js';
import { copySnapshot } from './snapshot.js';

export function feedbackDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Conservative file-level three-way integration; overlapping edits need human resolution. */
export function integrateBase(ancestor: Snapshot, target: Snapshot, head: Snapshot): Snapshot {
  const result = copySnapshot(head);
  for (const path of new Set([...ancestor.keys(), ...target.keys(), ...head.keys()])) {
    const old = ancestor.get(path), incoming = target.get(path), current = head.get(path);
    const oldMode = ancestor.modes?.get(path) ?? '100644', newMode = target.modes?.get(path) ?? '100644', currentMode = head.modes?.get(path) ?? '100644';
    const incomingChanged = old !== incoming || oldMode !== newMode, headChanged = old !== current || oldMode !== currentMode;
    if (!incomingChanged) continue;
    if (headChanged && (incoming !== current || newMode !== currentMode)) throw new Error('Base integration conflict: ' + path);
    if (incoming === undefined) { result.delete(path); result.modes?.delete(path); }
    else { result.set(path, incoming); result.modes?.set(path, newMode); }
  }
  return result;
}
