import { describe, expect, it } from 'vitest';
import { lookupReceipts } from '../../src/domain/lookup-receipts';
import {
  countReceipts,
  listNotes,
  processOperations,
} from '../../src/domain/sync';
import { createInMemoryStore } from '../../src/infrastructure/in-memory-store';

describe('batch receipt lookup', () => {
  it('returns a receipt and a missing result without applying operations', () => {
    const store = createInMemoryStore();
    const [created] = processOperations(store, [
      { op_id: 'A', note_id: 'N', base_revision: 0, text: 'start' },
    ]);
    const notes = listNotes(store);

    expect(lookupReceipts(store, ['A', 'Z'])).toStrictEqual([
      { op_id: 'A', result: created },
      { op_id: 'Z', result: null },
    ]);
    expect(listNotes(store)).toStrictEqual(notes);
    expect(countReceipts(store)).toBe(1);
  });

  it('returns a conflict receipt', () => {
    const store = createInMemoryStore();
    processOperations(store, [
      { op_id: 'A', note_id: 'N', base_revision: 0, text: 'start' },
    ]);
    const [conflict] = processOperations(store, [
      { op_id: 'B', note_id: 'N', base_revision: 0, text: 'proposal' },
    ]);

    expect(lookupReceipts(store, ['B'])).toStrictEqual([
      { op_id: 'B', result: conflict },
    ]);
  });

  it('returns an empty list for an empty request', () => {
    expect(lookupReceipts(createInMemoryStore(), [])).toStrictEqual([]);
  });
});
