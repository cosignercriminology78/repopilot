import type { Snapshot, TestResult } from '../domain/types.js';

export interface Runner { run(files: Snapshot, label: string, signal?: AbortSignal): Promise<TestResult>; }
