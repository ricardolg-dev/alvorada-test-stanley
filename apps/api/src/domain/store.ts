import type { Note, Receipt } from './model';

/**
 * The state the domain reads and writes: current notes and operation
 * receipts, kept apart on purpose. Receipts never follow the notes.
 */
export interface SyncStore {
  readonly notes: Map<string, Note>;
  readonly receipts: Map<string, Receipt>;
}

/** A store that can also be emptied in place, for demonstrations and tests. */
export interface ResettableSyncStore extends SyncStore {
  reset(): void;
}
