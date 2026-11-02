import type { ResettableSyncStore } from '../domain/store';

/** A store that lives in the memory of one process and starts empty. */
export function createInMemoryStore(): ResettableSyncStore {
  const store: ResettableSyncStore = {
    notes: new Map(),
    receipts: new Map(),
    reset(): void {
      store.notes.clear();
      store.receipts.clear();
    },
  };
  return store;
}
