import type { SyncStore } from '../domain/store';

/** A store that lives in the memory of one process and starts empty. */
export function createInMemoryStore(): SyncStore {
  return { notes: new Map(), receipts: new Map() };
}
