import type { Snapshot } from './types.js';

export function safePath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));
}
export function copySnapshot(files: Snapshot): Snapshot {
  const copy: Snapshot = new Map(files); copy.modes = new Map(files.modes); return copy;
}
export function changedPaths(base: Snapshot, head: Snapshot): string[] {
  return [...new Set([...base.keys(), ...head.keys()])].filter(path => base.get(path) !== head.get(path)
    || (base.modes?.get(path) ?? '100644') !== (head.modes?.get(path) ?? '100644')).sort();
}
