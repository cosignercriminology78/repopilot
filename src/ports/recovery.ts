export interface LockState { status: 'absent' | 'active' | 'stale' | 'unknown'; fingerprint: string; }
export interface RecoveryLock {
  inspect(): Promise<LockState>;
  acquire(expected: string): Promise<() => Promise<void>>;
}
export interface OwnedResource { kind: 'container' | 'network'; id: string; name: string; }
export interface RecoveryResources {
  list(): Promise<OwnedResource[]>;
  remove(resource: OwnedResource): Promise<void>;
}
