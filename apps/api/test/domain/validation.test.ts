import { describe, expect, it } from 'vitest';
import {
  countReceipts,
  getNote,
  listNotes,
  processOperations,
} from '../../src/domain/sync';
import { createInMemoryStore } from '../../src/infrastructure/in-memory-store';

const valid = { op_id: 'A', note_id: 'N', base_revision: 0, text: 'x' };

describe('invalid operations', () => {
  it.each([
    ['a missing op_id', { note_id: 'N', base_revision: 0, text: 'x' }],
    ['a missing note_id', { op_id: 'A', base_revision: 0, text: 'x' }],
    ['a missing base_revision', { op_id: 'A', note_id: 'N', text: 'x' }],
    ['a missing text', { op_id: 'A', note_id: 'N', base_revision: 0 }],
    ['an extra field', { ...valid, extra: 1 }],
    ['base revision -1', { ...valid, base_revision: -1 }],
    ['base revision 1.5', { ...valid, base_revision: 1.5 }],
    ['base revision "1"', { ...valid, base_revision: '1' }],
    ['an empty op_id', { ...valid, op_id: '' }],
    ['an empty note_id', { ...valid, note_id: '' }],
    ['a non-string text', { ...valid, text: 5 }],
  ])('gives invalid with a reason for %s', (_name, input) => {
    const store = createInMemoryStore();

    const [result] = processOperations(store, [input]);

    expect(result?.status).toBe('invalid');
    expect(result).toHaveProperty('reason');
    if (result?.status === 'invalid') {
      expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(countReceipts(store)).toBe(0);
    expect(listNotes(store)).toStrictEqual([]);
  });

  it.each([null, 'text', 7, [], [valid]])(
    'gives invalid without an op_id for the non-operation %j',
    (input) => {
      const [result] = processOperations(createInMemoryStore(), [input]);

      expect(result).toStrictEqual({
        status: 'invalid',
        reason: expect.any(String) as string,
      });
      expect(Object.keys(result ?? {})).not.toContain('op_id');
    },
  );

  it('carries op_id on an invalid result only when the input had a string op_id', () => {
    const [withId, withoutId, numeric] = processOperations(
      createInMemoryStore(),
      [
        { op_id: 'A', note_id: 'N', base_revision: -1, text: 'x' },
        { note_id: 'N', base_revision: 0, text: 'x' },
        { op_id: 5, note_id: 'N', base_revision: 0, text: 'x' },
      ],
    );

    expect(withId).toMatchObject({ op_id: 'A', status: 'invalid' });
    expect(Object.keys(withoutId ?? {})).toStrictEqual(['status', 'reason']);
    expect(Object.keys(numeric ?? {})).toStrictEqual(['status', 'reason']);
  });

  it('keeps an empty text valid', () => {
    const store = createInMemoryStore();

    const [result] = processOperations(store, [{ ...valid, text: '' }]);

    expect(result).toStrictEqual({
      op_id: 'A',
      status: 'created',
      note: { note_id: 'N', revision: 1, text: '' },
    });
  });
});

describe('ids that collide with Object prototype names', () => {
  it.each(['constructor', '__proto__'])(
    'treats op_id and note_id %s like any other id',
    (id) => {
      const store = createInMemoryStore();

      const [created] = processOperations(store, [
        { op_id: id, note_id: id, base_revision: 0, text: 'one' },
      ]);
      const [replay] = processOperations(store, [
        { op_id: id, note_id: id, base_revision: 0, text: 'one' },
      ]);
      const [reused] = processOperations(store, [
        { op_id: id, note_id: id, base_revision: 0, text: 'two' },
      ]);
      const [updated] = processOperations(store, [
        { op_id: `${id}-2`, note_id: id, base_revision: 1, text: 'two' },
      ]);

      expect(created).toStrictEqual({
        op_id: id,
        status: 'created',
        note: { note_id: id, revision: 1, text: 'one' },
      });
      expect(replay).toStrictEqual(created);
      expect(reused).toStrictEqual({ op_id: id, status: 'id_reutilizado' });
      expect(updated).toMatchObject({ status: 'updated' });
      expect(getNote(store, id)).toStrictEqual({
        note_id: id,
        revision: 2,
        text: 'two',
      });
      expect(countReceipts(store)).toBe(2);
    },
  );

  it('does not find a note or receipt for names inherited from Object', () => {
    const store = createInMemoryStore();

    expect(getNote(store, 'constructor')).toBeUndefined();
    expect(getNote(store, '__proto__')).toBeUndefined();
  });
});

describe('conflict on a note that does not exist', () => {
  it('gives note_not_found with no server data and the proposal', () => {
    const store = createInMemoryStore();

    const [result] = processOperations(store, [
      { op_id: 'A', note_id: 'N', base_revision: 1, text: 'mine' },
    ]);

    expect(result).toStrictEqual({
      op_id: 'A',
      status: 'conflito',
      reason: 'note_not_found',
      note_id: 'N',
      server: null,
      proposal: { base_revision: 1, text: 'mine' },
    });
    expect(listNotes(store)).toStrictEqual([]);
  });
});

describe('note listing', () => {
  it('returns a bare array sorted by note_id in code-unit order', () => {
    const store = createInMemoryStore();
    processOperations(
      store,
      ['a', 'B', 'CLM-2', 'CLM-10', 'b'].map((note_id, i) => ({
        op_id: `op-${i}`,
        note_id,
        base_revision: 0,
        text: note_id,
      })),
    );

    const ids = listNotes(store).map((note) => note.note_id);

    expect(ids).toStrictEqual(['B', 'CLM-10', 'CLM-2', 'a', 'b']);
  });

  it('returns copies, so changing a listed note leaves the store alone', () => {
    const store = createInMemoryStore();
    processOperations(store, [valid]);

    const [listed] = listNotes(store);
    if (listed === undefined) throw new Error('expected a note');
    listed.text = 'tampered';

    expect(getNote(store, 'N')?.text).toBe('x');
  });
});
