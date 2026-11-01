import { describe, expect, it } from 'vitest';
import {
  countReceipts,
  getNote,
  listNotes,
  processOperations,
} from '../../src/domain/sync';
import { createInMemoryStore } from '../../src/infrastructure/in-memory-store';

const op = (op_id: string, base_revision: number, text: string) => ({
  op_id,
  note_id: 'N',
  base_revision,
  text,
});

describe('statement example, O1 to O4 on an empty server', () => {
  it('walks through creation, update, conflict, replays and id reuse', () => {
    const store = createInMemoryStore();
    expect(listNotes(store)).toStrictEqual([]);

    const o1 = op('O1', 0, 'início');
    const o2 = op('O2', 1, 'edição A');
    const o3 = op('O3', 1, 'edição B');
    const o4 = op('O4', 2, 'A + B');

    const [r1] = processOperations(store, [o1]);
    expect(r1).toStrictEqual({
      op_id: 'O1',
      status: 'created',
      note: { note_id: 'N', revision: 1, text: 'início' },
    });

    const [r2] = processOperations(store, [o2]);
    expect(r2).toStrictEqual({
      op_id: 'O2',
      status: 'updated',
      note: { note_id: 'N', revision: 2, text: 'edição A' },
    });

    const [r3] = processOperations(store, [o3]);
    expect(r3).toStrictEqual({
      op_id: 'O3',
      status: 'conflito',
      reason: 'revision_mismatch',
      note_id: 'N',
      server: { note_id: 'N', revision: 2, text: 'edição A' },
      proposal: { base_revision: 1, text: 'edição B' },
    });
    expect(getNote(store, 'N')).toStrictEqual({
      note_id: 'N',
      revision: 2,
      text: 'edição A',
    });

    const [r2again] = processOperations(store, [o2]);
    expect(r2again).toStrictEqual(r2);
    expect(getNote(store, 'N')?.revision).toBe(2);

    const [r4] = processOperations(store, [o4]);
    expect(r4).toStrictEqual({
      op_id: 'O4',
      status: 'updated',
      note: { note_id: 'N', revision: 3, text: 'A + B' },
    });

    const [r3again] = processOperations(store, [o3]);
    expect(r3again).toStrictEqual(r3);
    expect(listNotes(store)).toStrictEqual([
      { note_id: 'N', revision: 3, text: 'A + B' },
    ]);

    const [reused] = processOperations(store, [op('O2', 2, 'another text')]);
    expect(reused).toStrictEqual({ op_id: 'O2', status: 'id_reutilizado' });
    expect(getNote(store, 'N')).toStrictEqual({
      note_id: 'N',
      revision: 3,
      text: 'A + B',
    });
    expect(processOperations(store, [o2])[0]).toStrictEqual(r2);
    expect(countReceipts(store)).toBe(4);
  });
});
