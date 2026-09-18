import type { Experience, GoalState } from '../domain/iteration.js';
export interface IterationStore {
  read(id: string): Promise<GoalState | undefined>;
  save(state: GoalState): Promise<void>;
  list(): Promise<GoalState[]>;
  pause(id: string): Promise<void>;
  paused(id: string): Promise<boolean>;
  unpause(id: string): Promise<void>;
  remember(entry: Experience): Promise<void>;
  experiences(): Promise<Experience[]>;
}
