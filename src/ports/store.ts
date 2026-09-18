import type { Report } from '../domain/types.js';
export interface Store {
  readonly root: string;
  acquire(): Promise<() => Promise<void>>;
  read(id: string): Promise<Report | undefined>;
  list(): Promise<Report[]>;
  save(report: Report): Promise<void>;
  archive(report: Report): Promise<void>;
  requestCancellation(id: string): Promise<void>;
  cancellationRequested(id: string): Promise<boolean>;
  clearCancellation(id: string): Promise<void>;
}
