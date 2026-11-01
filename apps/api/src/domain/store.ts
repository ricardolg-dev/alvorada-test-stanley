import type { Note, Receipt } from './model';

/**
 * The state the domain reads and writes: current notes and operation
 * receipts, kept apart on purpose. Receipts never follow the notes.
 */
export interface SyncStore {
  readonly notes: Map<string, Note>;
  readonly receipts: Map<string, Receipt>;
}
